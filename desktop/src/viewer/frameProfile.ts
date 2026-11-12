// Frame-time profile of the reading loop (bench only): scroll, zoom and
// window/level on the main stack viewport, one step per display frame, the way
// a reader drags. For every step it records input → IMAGE_RENDERED latency,
// and across the run every requestAnimationFrame interval, so a hitch shows as
// a long frame even when the render itself was fast.
//
// Gate: 60 fps means each step renders inside one 16.7 ms frame (p95) and no
// frame takes longer than two (33 ms, a visible drop).

type Core = typeof import("@cornerstonejs/core");

interface StackLike {
  element: HTMLElement;
  getCurrentImageIdIndex(): number;
  getImageIds(): string[];
  setImageIdIndex(i: number): Promise<unknown>;
  getCamera(): { parallelScale?: number };
  setCamera(c: { parallelScale?: number }): void;
  getProperties(): { voiRange?: { lower: number; upper: number } };
  setProperties(p: { voiRange: { lower: number; upper: number } }): void;
  render(): void;
}

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface InteractionProfile {
  scroll: Stats;
  zoom: Stats;
  windowLevel: Stats;
  /** requestAnimationFrame intervals across all three runs. */
  frames: Stats & { over33: number; over20: number };
}

export function stats(values: readonly number[]): Stats {
  const s = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s.length ? s[s.length - 1] : NaN) };
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

function rendered(core: Core, element: HTMLElement, timeoutMs = 500): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      element.removeEventListener(core.Enums.Events.IMAGE_RENDERED, done);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(done, timeoutMs);
    element.addEventListener(core.Enums.Events.IMAGE_RENDERED, done);
  });
}

async function run(core: Core, vp: StackLike, steps: number, act: (i: number) => void | Promise<unknown>): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    await nextFrame();
    const t0 = performance.now();
    const wait = rendered(core, vp.element);
    await act(i);
    await wait;
    latencies.push(performance.now() - t0);
  }
  return latencies;
}

export async function profileInteraction(core: Core, vp: StackLike, scrollSteps = 120): Promise<InteractionProfile> {
  const intervals: number[] = [];
  let watching = true;
  let last = performance.now();
  const tick = (t: number) => {
    intervals.push(t - last);
    last = t;
    if (watching) requestAnimationFrame(tick);
  };
  requestAnimationFrame((t) => {
    last = t;
    requestAnimationFrame(tick);
  });

  const ids = vp.getImageIds();
  const start = vp.getCurrentImageIdIndex();
  // Scroll down through the stack (wrapping), like a wheel/drag sweep.
  const scroll = await run(core, vp, Math.min(scrollSteps, ids.length * 2), (i) =>
    vp.setImageIdIndex((start + i + 1) % ids.length)
  );
  // Zoom in then out.
  const base = vp.getCamera().parallelScale ?? 1;
  const zoom = await run(core, vp, 60, (i) => {
    const f = i < 30 ? 1 - 0.015 * (i + 1) : 1 - 0.015 * (60 - i);
    vp.setCamera({ parallelScale: base * f });
    vp.render();
  });
  vp.setCamera({ parallelScale: base });
  // Window/level drag.
  const voi = vp.getProperties().voiRange ?? { lower: -160, upper: 240 };
  const windowLevel = await run(core, vp, 60, (i) => {
    const d = (i < 30 ? i : 60 - i) * 6;
    vp.setProperties({ voiRange: { lower: voi.lower + d, upper: voi.upper + 2 * d } });
    vp.render();
  });
  vp.setProperties({ voiRange: voi });
  watching = false;

  // Drop the first interval (warm-up).
  const frameStats = stats(intervals.slice(1));
  return {
    scroll: stats(scroll),
    zoom: stats(zoom),
    windowLevel: stats(windowLevel),
    frames: {
      ...frameStats,
      over33: intervals.slice(1).filter((x) => x > 33.4).length,
      over20: intervals.slice(1).filter((x) => x > 20).length,
    },
  };
}
