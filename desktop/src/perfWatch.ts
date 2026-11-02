// Main-thread long-task watch. Budget: no task over 50 ms. Every long task is
// logged (console.warn with its duration and attribution) and counted, so the
// memory HUD and the benchmark report can show them. Chromium (WebView2) only;
// elsewhere it is a no-op.

export interface LongTaskStats {
  count: number;
  maxMs: number;
  totalMs: number;
  /** The most recent few, newest last. */
  recent: { at: number; ms: number; name: string }[];
}

export const longTasks: LongTaskStats = { count: 0, maxMs: 0, totalMs: 0, recent: [] };

export const LONG_TASK_MS = 50;

// Named phases (engine init, series load, view switch, ...): a long task is
// attributed to the phase running when it ended, so the HP and CI reports say
// WHAT froze instead of "unknown".
const phases: { name: string; at: number }[] = [];

/** Mark the start of a phase of work on the main thread. Cheap; keep it coarse. */
export function markPhase(name: string): void {
  phases.push({ name, at: performance.now() });
  if (phases.length > 64) phases.shift();
}

function phaseAt(start: number, end: number): string | null {
  // Phases that began inside the task, else the latest one shortly before it.
  const inside = phases.filter((p) => p.at >= start && p.at <= end).map((p) => p.name);
  if (inside.length) return [...new Set(inside)].join(" + ");
  const before = [...phases].reverse().find((p) => p.at < start && start - p.at < 1500);
  return before?.name ?? null;
}

let installed = false;

export function watchLongTasks(): void {
  if (installed || typeof PerformanceObserver === "undefined") return;
  if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
  installed = true;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const ms = Math.round(entry.duration);
      if (ms <= LONG_TASK_MS) continue;
      longTasks.count += 1;
      longTasks.totalMs += ms;
      longTasks.maxMs = Math.max(longTasks.maxMs, ms);
      const attribution = (entry as unknown as { attribution?: { containerName?: string; name?: string }[] }).attribution?.[0];
      const name = phaseAt(entry.startTime, entry.startTime + entry.duration) ?? (attribution?.containerName || attribution?.name || entry.name);
      longTasks.recent.push({ at: Math.round(entry.startTime), ms, name });
      if (longTasks.recent.length > 8) longTasks.recent.shift();
      console.warn(`FlowRad: main-thread task ${ms} ms (budget ${LONG_TASK_MS} ms)`, name);
    }
  }).observe({ type: "longtask", buffered: true });
}
