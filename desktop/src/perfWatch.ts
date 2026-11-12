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

// Long Animation Frames (Chromium 123+, so every WebView2 we run on): for a
// long task outside any named phase, the script that ran (function, file,
// what invoked it) or, when no script ran, where the time went (style/layout,
// or neither: GC / engine-internal work). This is what turns "unknown" into
// something to fix.
interface LoafScript {
  duration: number;
  invoker?: string;
  invokerType?: string;
  sourceFunctionName?: string;
  sourceURL?: string;
  sourceCharPosition?: number;
}
interface LoafEntry {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  styleAndLayoutStart?: number;
  renderStart?: number;
  scripts?: LoafScript[];
}
const loafs: LoafEntry[] = [];
const pending: { record: { ms: number; name: string }; base: string; start: number; end: number }[] = [];

function shortUrl(url = ""): string {
  const tail = url.split(/[?#]/)[0].split("/").pop() ?? "";
  return tail.replace(/-[\w-]{8}\.js$/, ".js");
}

/** What a long frame spent its time on, in a few words. */
export function describeFrame(f: LoafEntry): string {
  const scripts = [...(f.scripts ?? [])].sort((a, b) => b.duration - a.duration);
  const top = scripts[0];
  const layout = f.styleAndLayoutStart ? Math.round(f.startTime + f.duration - f.styleAndLayoutStart) : 0;
  const scriptMs = Math.round(scripts.reduce((n, x) => n + x.duration, 0));
  if (top && top.duration >= 10) {
    const fn = top.sourceFunctionName || "(anonymous)";
    const where = top.sourceURL ? ` ${shortUrl(top.sourceURL)}:${top.sourceCharPosition ?? "?"}` : "";
    const via = top.invoker ? ` via ${top.invoker}` : top.invokerType ? ` via ${top.invokerType}` : "";
    return `script ${fn}${where}${via} ${Math.round(top.duration)} ms`;
  }
  if (layout >= 10) return `style/layout ${layout} ms`;
  return `no script (${scriptMs} ms JS): GC or engine-internal`;
}

function frameFor(start: number, end: number): LoafEntry | undefined {
  return loafs.find((f) => f.startTime <= end && f.startTime + f.duration >= start);
}

let installed = false;

export function watchLongTasks(): void {
  if (installed || typeof PerformanceObserver === "undefined") return;
  if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
  installed = true;
  const loafSupported = PerformanceObserver.supportedEntryTypes.includes("long-animation-frame");
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const ms = Math.round(entry.duration);
      if (ms <= LONG_TASK_MS) continue;
      longTasks.count += 1;
      longTasks.totalMs += ms;
      longTasks.maxMs = Math.max(longTasks.maxMs, ms);
      const attribution = (entry as unknown as { attribution?: { containerName?: string; name?: string }[] }).attribution?.[0];
      const start = entry.startTime;
      const end = entry.startTime + entry.duration;
      const phase = phaseAt(start, end);
      const record = { at: Math.round(start), ms, name: phase ?? (attribution?.containerName || attribution?.name || "unknown") };
      longTasks.recent.push(record);
      if (longTasks.recent.length > 8) longTasks.recent.shift();
      // Every long task gets the frame's detail when there is one: a phase
      // label alone can mislead (the React render after "study: group
      // series" ran in the next task and was booked to it: 185 ms on the HP).
      const base = record.name;
      if (loafSupported) {
        // Observer callbacks run at low priority, so the matching
        // long-animation-frame entry may come later: name it either now or
        // when that entry arrives (below).
        const frame = frameFor(start, end);
        if (frame) record.name = `${base}: ${describeFrame(frame)}`;
        else pending.push({ record, base, start, end });
        if (pending.length > 16) pending.shift();
      }
      console.warn(`FlowRad: main-thread task ${ms} ms (budget ${LONG_TASK_MS} ms)`, record.name);
    }
  }).observe({ type: "longtask", buffered: true });
  if (loafSupported) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as LoafEntry[]) {
        if (entry.duration <= LONG_TASK_MS) continue;
        loafs.push(entry);
        if (loafs.length > 32) loafs.shift();
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          const p = pending[i];
          if (entry.startTime <= p.end && entry.startTime + entry.duration >= p.start) {
            p.record.name = `${p.base}: ${describeFrame(entry)}`;
            console.warn(`FlowRad: main-thread task ${p.record.ms} ms was`, p.record.name);
            pending.splice(i, 1);
          }
        }
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  }
}
