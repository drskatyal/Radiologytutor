// FLOWRAD_DIAG=1 only (diagnosis, off in every normal run): the page reports
// when its own main thread was busy and what it loaded when, as FLOWRAD_DIAG
// lines on the app's stdout (lib.rs `diag_log`, stamped with the process
// clock). WebKit has no Long Tasks API, so a late timer is the only way to see
// a busy page there. Times are ms from the page's navigation start.
import { invoke, isTauri } from "./platform";

/** Boot phases (ms from navigation start), sent once diagnosis is known to be on. */
const marks: [string, number][] = [];
let sendMark: ((name: string, at: number) => void) | null = null;
export function diagMark(name: string): void {
  const at = Math.round(performance.now());
  if (sendMark) sendMark(name, at);
  else if (marks.length < 64) marks.push([name, at]);
}

export function startDiag(): void {
  if (!isTauri) return;
  void invoke<boolean>("diag_enabled")
    .then(async (on) => {
      if (!on) return;
      const log = (entry: Record<string, unknown>) => void invoke("diag_log", { entry }).catch(() => undefined);
      const before = performance.now();
      const processMs = await invoke<number>("startup_elapsed_ms").catch(() => 0);
      log({ navAtProcessMs: Math.round(processMs - (before + performance.now()) / 2) });
      sendMark = (name, at) => log({ mark: name, at });
      for (const [name, at] of marks.splice(0)) sendMark(name, at);
      const seen = new Set<string>();
      let last = performance.now();
      const end = last + 20_000;
      const timer = window.setInterval(() => {
        const now = performance.now();
        if (now - last > 50) {
          // Chunks requested so far (Vite adds a modulepreload link per dependency).
          const chunks = [...document.querySelectorAll<HTMLLinkElement>("link[rel=modulepreload],script[src]")].map((l) =>
            (l.getAttribute("href") ?? l.getAttribute("src") ?? "").split("/").pop()
          );
          const fresh = chunks.filter((c) => !seen.has(c ?? ""));
          fresh.forEach((c) => seen.add(c ?? ""));
          log({ stallAt: Math.round(last), ms: Math.round(now - last), newChunks: fresh, phase: document.querySelector(".boot") ? "boot splash" : "app" });
        }
        last = now;
        if (now > end) window.clearInterval(timer);
      }, 10);
      // Rendering updates (rAF / ResizeObserver run in them): a late frame
      // with on-time timers is WebKit holding rendering, not a busy page.
      let lastFrame = performance.now();
      const frame = (now: number) => {
        if (now - lastFrame > 50) log({ frameGapAt: Math.round(lastFrame), ms: Math.round(now - lastFrame), visibility: document.visibilityState });
        lastFrame = now;
        if (now < end) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      document.addEventListener("visibilitychange", () => log({ visibility: document.visibilityState, at: Math.round(performance.now()) }));
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as PerformanceResourceTiming[]) {
            if (!/\/assets\//.test(e.name)) continue;
            log({ resource: e.name.split("/").pop(), start: Math.round(e.startTime), end: Math.round(e.responseEnd), bytes: e.decodedBodySize || null });
          }
        }).observe({ type: "resource", buffered: true });
      } catch {
        /* no resource timing */
      }
    })
    .catch(() => undefined);
}
