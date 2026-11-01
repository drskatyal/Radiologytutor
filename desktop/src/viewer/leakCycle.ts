// Feature on/off leak test (bench only, FLOWRAD_BENCH_VIEW=leak). With a CT
// open in 2D: settle and sample the whole process tree, then open and close
// every feature — MPR, 3D, cine, measurements tool, export, settings, PACS —
// twice, sampling after each full round. A feature that leaks shows as growth
// round over round; the gate is "back to near baseline".

import { invoke } from "../platform";
import { longTasks } from "../perfWatch";
import { decodeWorkers, enginePeek } from "./engine";

export interface LeakDriver {
  /** Switch view; resolves when a volume view has loaded its volume (or at once for grid). */
  setView(view: "grid" | "mpr" | "3d"): Promise<void>;
  setDialog(dialog: "export" | "settings" | "pacs" | null): void;
  toggleCine(): void;
  setTool(tool: string): void;
}

export interface Sample {
  label: string;
  treeMb: number;
  heapMb: number | null;
  cacheMb: number | null;
  volumes: number;
  workers: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sample(label: string, settleMs: number): Promise<Sample> {
  await wait(settleMs);
  const engine = enginePeek();
  const cache = engine?.core.cache as unknown as { getCacheSize?: () => number; getVolumes?: () => unknown[] } | undefined;
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const tree = await invoke<{ totalMb: number }>("process_memory").catch(() => ({ totalMb: 0 }));
  return {
    label,
    treeMb: tree.totalMb,
    heapMb: heap ? Math.round(heap.usedJSHeapSize / 1048576) : null,
    cacheMb: cache?.getCacheSize ? Math.round(cache.getCacheSize() / 1048576) : null,
    volumes: cache?.getVolumes?.().length ?? 0,
    workers: decodeWorkers().live,
  };
}

export async function runLeakCycle(d: LeakDriver, { rounds = 2, settleMs = 6000 } = {}) {
  const samples: Sample[] = [await sample("baseline", settleMs)];
  let peakMb = samples[0].treeMb;
  const peek = async () => {
    const t = await invoke<{ totalMb: number }>("process_memory").catch(() => ({ totalMb: 0 }));
    peakMb = Math.max(peakMb, t.totalMb);
  };
  for (let round = 1; round <= rounds; round += 1) {
    for (const view of ["mpr", "3d"] as const) {
      await d.setView(view);
      await wait(800);
      await peek();
      await d.setView("grid");
      await wait(500);
    }
    d.toggleCine();
    await wait(1500);
    d.toggleCine();
    for (const tool of ["Length", "EllipticalROI", "WindowLevel"]) {
      d.setTool(tool);
      await wait(150);
    }
    for (const dialog of ["export", "settings", "pacs"] as const) {
      d.setDialog(dialog);
      await wait(400);
      d.setDialog(null);
      await wait(150);
    }
    samples.push(await sample(`round ${round}`, settleMs));
  }
  const base = samples[0].treeMb;
  const last = samples[samples.length - 1].treeMb;
  return {
    samples,
    baselineMb: base,
    finalMb: last,
    peakMb,
    leakMb: last - base,
    /** Growth from the first round to the last: a steady leak, independent of warm-up. */
    roundGrowthMb: samples.length > 2 ? last - samples[1].treeMb : 0,
    longTasks: { count: longTasks.count, maxMs: longTasks.maxMs },
  };
}
