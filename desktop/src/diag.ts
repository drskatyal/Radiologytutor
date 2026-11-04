// Diagnostics only (macOS, FLOWRAD_DIAG=1 with the bench on: the shell sets
// `window.__flowradDiag` before the page's first line). Off, every export is
// a no-op. Records late page timers (the page's own thread or its timers
// stalled), visibility changes, slow IPC calls and named marks, all on the
// page clock (performance.now()); the bench report carries them.

const w = typeof window !== "undefined" ? (window as unknown as { __flowradDiag?: number }) : undefined;
export const diagOn = w?.__flowradDiag === 1;

const r1 = (x: number) => Math.round(x * 10) / 10;

const rec = {
  marks: [] as [number, string][],
  timerLate: [] as [number, number, string][],
  visibility: [] as [number, string][],
  invokes: [] as [number, string, number][],
  workerLate: [] as [number, number][],
};
let workerRef: Worker | null = null;
/** Ask the worker for its gaps (they arrive asynchronously; call before the snapshot). */
export function diagPoll(): Promise<void> {
  const w = workerRef;
  if (!diagOn || !w) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    w.addEventListener("message", done, { once: true });
    w.postMessage(0);
    window.setTimeout(done, 200);
  });
}

export function diagMark(label: string): void {
  if (diagOn && rec.marks.length < 400) rec.marks.push([r1(performance.now()), label]);
}

export function diagInvoke(cmd: string, started: number): void {
  if (!diagOn) return;
  const ms = performance.now() - started;
  if (ms > 25 && rec.invokes.length < 400) rec.invokes.push([r1(started), cmd, r1(ms)]);
}

if (diagOn) {
  // Timer heartbeat: a 10 ms timer that fires more than 40 ms late.
  let last = performance.now();
  const beat = () => {
    const now = performance.now();
    const late = now - last - 10;
    if (late > 40 && rec.timerLate.length < 400) rec.timerLate.push([r1(last + 10), r1(late), document.visibilityState]);
    last = now;
    if (now < 60_000) window.setTimeout(beat, 10);
  };
  window.setTimeout(beat, 10);
  // The same heartbeat on a worker thread (same process, its own thread): a
  // gap on both = the whole process stalled; on the page only = its main thread.
  try {
    const src = `let last=performance.now(),gaps=[];const beat=()=>{const now=performance.now();const late=now-last-10;if(late>40&&gaps.length<400)gaps.push([Math.round((last+10)*10)/10,Math.round(late*10)/10]);last=now;if(now<60000)setTimeout(beat,10)};setTimeout(beat,10);onmessage=()=>postMessage({origin:performance.timeOrigin,gaps});`;
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = (e) => {
      // Worker clock -> page clock (each starts at its own time origin).
      const { origin, gaps } = e.data as { origin: number; gaps: [number, number][] };
      const shift = origin - performance.timeOrigin;
      rec.workerLate = gaps.map(([t, late]) => [r1(t + shift), late]);
    };
    workerRef = worker;
  } catch {
    /* no worker */
  }
  const vis = (what: string) => () => rec.visibility.push([r1(performance.now()), `${what}: ${document.visibilityState} focus=${document.hasFocus()}`]);
  vis("start")();
  document.addEventListener("visibilitychange", vis("visibilitychange"));
  window.addEventListener("focus", vis("focus"));
  window.addEventListener("blur", vis("blur"));
  window.addEventListener("pageshow", vis("pageshow"));
}

export function diagSnapshot(): unknown {
  if (!diagOn) return undefined;
  const resources = performance
    .getEntriesByType("resource")
    .map((e) => {
      const r = e as PerformanceResourceTiming;
      return [r.name.split("/").pop()?.slice(0, 48), r1(r.startTime), r1(r.responseStart), r1(r.responseEnd), r1(r.duration)];
    })
    .filter((x) => !String(x[0]).match(/^\d+$/)); // not the dicom:// file fetches
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return {
    ...rec,
    resources: resources.slice(0, 120),
    nav: nav ? { responseEnd: r1(nav.responseEnd), domInteractive: r1(nav.domInteractive), dcl: r1(nav.domContentLoadedEventEnd), load: r1(nav.loadEventEnd) } : null,
    paints: performance.getEntriesByType("paint").map((p) => [p.name, r1(p.startTime)]),
    nowAtReport: r1(performance.now()),
  };
}
