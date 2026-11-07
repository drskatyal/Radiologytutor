// Scripted interaction pass (bench only, FLOWRAD_BENCH_VIEW=steps; bench.mjs
// `steps`): the reading loop the owner times on real hardware. On the main
// viewport, one step per display frame:
//
//   scroll        120 slices down (wrapping), one slice per step
//   windowLevel    60 W/L drags (width and centre move together)
//   rotate         24 × 90° clockwise (six full turns)
//
// Each step is timed from the request to the frame being drawn: the native
// renderer's answer after it presented (same calls as native/benchInteract.ts),
// or Cornerstone's IMAGE_RENDERED on the JS renderer. Reported per kind and
// overall: p50 / p95 / max, plus main-thread long tasks (> 50 ms) that ended
// during the pass, and rAF frame intervals. The view is put back afterwards
// (slice, window, rotation).

import { invoke } from "./platform";
import { longTasks } from "./perfWatch";
import { stats, type Stats } from "./viewer/frameProfile";

type Core = typeof import("@cornerstonejs/core");

/** The Cornerstone stack viewport calls this pass uses (JS renderer). */
interface StackLike {
  element: HTMLElement;
  getCurrentImageIdIndex(): number;
  getImageIds(): string[];
  setImageIdIndex(i: number): Promise<unknown>;
  getProperties(): { voiRange?: { lower: number; upper: number } };
  setProperties(p: { voiRange: { lower: number; upper: number } }): void;
  getViewPresentation?(): { rotation?: number } | undefined;
  setViewPresentation(p: { rotation: number }): void;
  render(): void;
}

interface NativeShown {
  index: number;
  totalMs: number;
  view: { wl: [number, number]; rotation: number };
}

/** One step: perform it and resolve when its frame is drawn. */
interface Driver {
  renderPath: "native" | "engine";
  scroll(i: number): Promise<void>;
  windowLevel(i: number): Promise<void>;
  rotate(i: number): Promise<void>;
  restore(): Promise<void>;
}

export const STEP_COUNTS = { scroll: 120, windowLevel: 60, rotate: 24 } as const;

export async function nativeDriver(cellId: string): Promise<Driver> {
  const base = await invoke<NativeShown>("native_cell_view", { id: cellId, patch: {} });
  const view = (patch: Record<string, unknown>) => invoke<NativeShown>("native_cell_view", { id: cellId, patch }).then(() => undefined);
  return {
    renderPath: "native",
    scroll: () => invoke<NativeShown>("native_cell_scroll", { id: cellId, delta: 1 }).then(() => undefined),
    windowLevel: (i) => view({ wl: [base.view.wl[0] + 4 * (i % 30), base.view.wl[1] + 8 * (i % 30)] }),
    rotate: (i) => view({ rotation: ((base.view.rotation + 90 * (i + 1)) % 360 + 360) % 360 }),
    restore: () => view({ index: base.index, wl: base.view.wl, rotation: base.view.rotation }),
  };
}

export function engineDriver(core: Core, vp: StackLike): Driver {
  const rendered = (act: () => void | Promise<unknown>, timeoutMs = 1000) =>
    new Promise<void>((resolve) => {
      const ev = core.Enums.Events.IMAGE_RENDERED;
      const done = () => {
        vp.element.removeEventListener(ev, done);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, timeoutMs);
      vp.element.addEventListener(ev, done);
      void act();
    });
  const ids = vp.getImageIds();
  const start = vp.getCurrentImageIdIndex();
  const voi = vp.getProperties().voiRange ?? { lower: -160, upper: 240 };
  const rotation = vp.getViewPresentation?.()?.rotation ?? 0;
  return {
    renderPath: "engine",
    scroll: (i) => rendered(() => vp.setImageIdIndex((start + i + 1) % ids.length)),
    windowLevel: (i) =>
      rendered(() => {
        const d = 4 * (i % 30);
        vp.setProperties({ voiRange: { lower: voi.lower - d, upper: voi.upper + 3 * d } });
        vp.render();
      }),
    rotate: (i) =>
      rendered(() => {
        vp.setViewPresentation({ rotation: (rotation + 90 * (i + 1)) % 360 });
        vp.render();
      }),
    restore: async () => {
      vp.setViewPresentation({ rotation });
      vp.setProperties({ voiRange: voi });
      await vp.setImageIdIndex(start);
      vp.render();
    },
  };
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

export interface StepsReport {
  renderPath: "native" | "engine";
  scroll: Stats;
  windowLevel: Stats;
  rotate: Stats;
  /** Every step of the pass. */
  all: Stats;
  /** The slowest step and which kind it was. */
  slowest: { kind: string; step: number; ms: number } | null;
  /** Main-thread tasks over 50 ms that ended during the pass. */
  longTasks: { count: number; maxMs: number; totalMs: number; recent: { ms: number; name: string }[] };
  frames: Stats & { over33: number; over20: number };
  totalMs: number;
}

export async function runStepsPass(d: Driver): Promise<StepsReport> {
  const before = { count: longTasks.count, totalMs: longTasks.totalMs };
  const t0 = performance.now();
  const intervals: number[] = [];
  let last = performance.now();
  let watching = true;
  const tick = (t: number) => {
    intervals.push(t - last);
    last = t;
    if (watching) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  let slowest: StepsReport["slowest"] = null;
  const all: number[] = [];
  const run = async (kind: keyof typeof STEP_COUNTS, act: (i: number) => Promise<void>) => {
    const out: number[] = [];
    for (let i = 0; i < STEP_COUNTS[kind]; i += 1) {
      await nextFrame();
      const s = performance.now();
      await act(i);
      const ms = performance.now() - s;
      out.push(ms);
      all.push(ms);
      if (!slowest || ms > slowest.ms) slowest = { kind, step: i, ms: Math.round(ms * 10) / 10 };
    }
    return out;
  };
  const scroll = await run("scroll", d.scroll);
  const windowLevel = await run("windowLevel", d.windowLevel);
  const rotate = await run("rotate", d.rotate);
  watching = false;
  const totalMs = Math.round(performance.now() - t0);
  await d.restore().catch(() => undefined);
  // `recent` keeps the last few: max and names are over those; count and total are exact.
  const during = longTasks.recent.filter((t) => t.at >= t0);
  const f = intervals.slice(1);
  return {
    renderPath: d.renderPath,
    scroll: stats(scroll),
    windowLevel: stats(windowLevel),
    rotate: stats(rotate),
    all: stats(all),
    slowest,
    longTasks: {
      count: longTasks.count - before.count,
      maxMs: Math.round(Math.max(0, ...during.map((t) => t.ms))),
      totalMs: Math.round(longTasks.totalMs - before.totalMs),
      recent: during.map((t) => ({ ms: t.ms, name: t.name })),
    },
    frames: { ...stats(f), over33: f.filter((x) => x > 33.4).length, over20: f.filter((x) => x > 20).length },
    totalMs,
  };
}
