// P2.6 (bench only, FLOWRAD_BENCH_VIEW=interact on a native viewport): the
// same frame-time profile as viewer/frameProfile.ts — scroll 120 slices,
// zoom, window/level, one step per frame — measured on the native renderer,
// so the CI interaction gates keep measuring what readers use after cutover.
// Each step is timed from the request to the native frame being presented
// (IPC + decode/cache + upload + draw); frame intervals come from rAF.

import { invoke } from "../platform";

type Stats = { n: number; p50: number; p95: number; max: number };

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s.length ? s[s.length - 1] : NaN) };
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

interface Shown {
  frameMs: number;
  decodeMs: number;
  totalMs: number;
  view: { zoom: number; wl: [number, number] };
}

export async function profileNativeInteraction(cellId: string) {
  const intervals: number[] = [];
  let last = performance.now();
  let measuring = true;
  const tick = (t: number) => {
    intervals.push(t - last);
    last = t;
    if (measuring) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const rustFrame: number[] = [];
  const run = async (steps: number, act: (i: number) => Promise<Shown>) => {
    const out: number[] = [];
    for (let i = 0; i < steps; i += 1) {
      await nextFrame();
      const t0 = performance.now();
      const r = await act(i);
      out.push(performance.now() - t0);
      rustFrame.push(r.totalMs);
    }
    return out;
  };
  const scroll = await run(120, () => invoke<Shown>("native_cell_scroll", { id: cellId, delta: 1 }));
  const zoom = await run(30, (i) => invoke<Shown>("native_cell_view", { id: cellId, patch: { zoom: 1 + 0.02 * (i % 15) } }));
  const base = await invoke<Shown>("native_cell_view", { id: cellId, patch: {} });
  const windowLevel = await run(30, (i) =>
    invoke<Shown>("native_cell_view", { id: cellId, patch: { wl: [base.view.wl[0] + 4 * i, base.view.wl[1] + 8 * i] } })
  );
  measuring = false;
  const frames = stats(intervals.slice(1));
  return {
    scroll: stats(scroll),
    zoom: stats(zoom),
    windowLevel: stats(windowLevel),
    // Inside Rust (decode / cache + upload + draw + present), per step.
    native: stats(rustFrame),
    frames: {
      ...frames,
      over33: intervals.slice(1).filter((x) => x > 33.4).length,
      over20: intervals.slice(1).filter((x) => x > 20).length,
    },
  };
}
