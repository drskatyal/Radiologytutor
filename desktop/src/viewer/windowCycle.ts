// Real-app multi-window bench (FLOWRAD_BENCH_VIEW=multiwindow): with a CT
// open, open a second viewer window, check it reports in, paints and obeys
// the main window over the window bus, close it, and sample the whole process
// tree before / during / after. Twice, so a per-window leak shows as growth.
//
// The browser e2e drives the same UI; this is what only the real shell can
// show: Tauri webviews, the Rust handoff, and memory returning on close.

import type { WindowSyncMessage } from "@flowrad/viewer-core";
import { invoke } from "../platform";
import { onWindowMessage, postToWindows, windowId } from "../multiWindow";
import { longTasks } from "../perfWatch";

export interface WindowCycleDriver {
  /** Open a viewer window showing `uid`; resolves to its id. */
  open(uid: string): Promise<string | null>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const treeMb = async () => (await invoke<{ totalMb: number }>("process_memory").catch(() => ({ totalMb: 0 }))).totalMb;

function nextMessage(pred: (m: WindowSyncMessage) => boolean, timeoutMs: number): Promise<WindowSyncMessage | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
    const off = onWindowMessage((m) => {
      if (!pred(m)) return;
      window.clearTimeout(timer);
      off();
      resolve(m);
    });
  });
}

export async function runWindowCycle(d: WindowCycleDriver, series: [string, string], { rounds = 2, settleMs = 6000 } = {}) {
  await wait(settleMs);
  const baselineMb = await treeMb();
  // Long tasks while windows open and close — not the main window's own
  // startup (engine init, first series), which the desktop bench gates.
  const tasksBefore = { count: longTasks.count, totalMs: longTasks.totalMs };
  const cycleStart = performance.now();
  const runs: { openMs: number | null; paintMs: number | null; roundTripMs: number | null; openMb: number; closedMb: number }[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const t0 = performance.now();
    const reported = nextMessage((m) => m.kind === "window-state", 30_000);
    const painted = nextMessage((m) => m.kind === "slice" || m.kind === "plane", 30_000);
    const id = await d.open(series[0]);
    if (!id) break;
    const state = await reported;
    const openMs = state ? Math.round(performance.now() - t0) : null;
    const first = await Promise.race([painted, wait(30_000).then(() => null)]);
    const paintMs = first ? Math.round(performance.now() - t0) : null;
    // Main → window → main: show another series there, wait for its new state.
    const t1 = performance.now();
    const shown = nextMessage((m) => m.kind === "window-state" && m.from === id && m.cells[0] === series[1], 15_000);
    postToWindows({ kind: "show-series", from: windowId, to: id, seriesUid: series[1] });
    const roundTripMs = (await shown) ? Math.round(performance.now() - t1) : null;
    await wait(2000);
    const openMb = await treeMb();
    const closed = nextMessage((m) => m.kind === "closed" && m.from === id, 10_000);
    await invoke("close_viewer_window", { label: id }).catch(() => undefined);
    await closed;
    await wait(settleMs);
    runs.push({ openMs, paintMs, roundTripMs, openMb, closedMb: await treeMb() });
  }
  const last = runs[runs.length - 1];
  return {
    baselineMb,
    runs,
    /** What one open window costs while open. */
    perWindowMb: last ? Math.max(...runs.map((r) => r.openMb)) - baselineMb : null,
    /** After closing every window: back to baseline? */
    leakMb: last ? last.closedMb - baselineMb : null,
    longTasks: {
      count: longTasks.count - tasksBefore.count,
      totalMs: longTasks.totalMs - tasksBefore.totalMs,
      recent: longTasks.recent.filter((t) => t.at >= cycleStart),
    },
    ok: runs.length === rounds && runs.every((r) => r.openMs != null && r.paintMs != null && r.roundTripMs != null),
  };
}
