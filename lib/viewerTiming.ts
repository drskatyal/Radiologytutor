// Console + User Timing marks for viewer open.
//
// navigation → first pixel: one frame has been drawn.
// navigation → series ready: the active stack is scrollable (imageIds set).
// Read them in DevTools → Performance, or in the console during a ~1000-image load.

let navSeq = 0;

function canMark(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

/** Call when a viewer navigation starts (mount or series change). Returns the mark name. */
export function markViewerNavigation(seriesUID: string): string {
  const name = `radlearn:nav:${++navSeq}`;
  if (canMark()) performance.mark(name);
  console.info("[radlearn] viewer navigation", { seriesUID });
  return name;
}

function measure(name: string, start: string, end: string): number | undefined {
  if (!canMark() || typeof performance.measure !== "function") return undefined;
  try {
    const entry = performance.measure(name, start, end);
    return Math.round(entry.duration);
  } catch {
    return undefined;
  }
}

/** One decoded frame is on screen. `ms` is milliseconds since navigation. */
export function markViewerFirstPixel(navMark: string, seriesUID: string): void {
  const end = `radlearn:first-pixel:${navMark}`;
  if (canMark()) performance.mark(end);
  const ms = measure("radlearn:navigation-to-first-pixel", navMark, end);
  console.info("[radlearn] viewer first pixel", { seriesUID, ms });
}

/** The active series has its full imageId stack. Scrolling can request any slice. */
export function markViewerSeriesReady(navMark: string, seriesUID: string, imageCount: number): void {
  const end = `radlearn:series-ready:${navMark}`;
  if (canMark()) performance.mark(end);
  const ms = measure("radlearn:navigation-to-series-ready", navMark, end);
  console.info("[radlearn] viewer series ready", { seriesUID, imageCount, ms });
}
