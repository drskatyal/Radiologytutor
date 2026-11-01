// Console + User Timing marks for viewer open.
//
// navigation → first pixel: one frame has been drawn.
// navigation → first preview: an 8-bit preview is on screen (converted bundle only).
// navigation → full quality: the slice on screen is the real 16-bit frame.
// navigation → series ready: the active stack is scrollable (imageIds set).
// Read them in DevTools → Performance, or in the console during a ~1000-image load.
//
// Privacy: the console lines carry timings and counts only — never a study,
// series or instance UID, never a header value. The same viewer opens files
// off a user's own disk (/viewer), where a UID is an identifier of a real
// patient's study. Parameters that name a series exist for callers; they are
// deliberately not printed.

let navSeq = 0;

function canMark(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

/** Call when a viewer navigation starts (mount or series change). Returns the mark name. */
export function markViewerNavigation(seriesUID: string): string {
  const name = `radlearn:nav:${++navSeq}`;
  if (canMark()) performance.mark(name);
  void seriesUID;
  console.info("[radlearn] viewer navigation");
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
  console.info("[radlearn] viewer first pixel", { ms });
}

/** The active series has its full imageId stack. Scrolling can request any slice. */
export function markViewerSeriesReady(navMark: string, seriesUID: string, imageCount: number): void {
  const end = `radlearn:series-ready:${navMark}`;
  if (canMark()) performance.mark(end);
  const ms = measure("radlearn:navigation-to-series-ready", navMark, end);
  console.info("[radlearn] viewer series ready", { imageCount, ms });
}

/**
 * The opening slice is on screen as an 8-bit preview (converted bundle path).
 * `ms` is milliseconds since navigation. DICOMweb opens never fire this.
 */
export function markViewerFirstPreview(navMark: string, seriesUID: string): void {
  const end = `radlearn:first-preview:${navMark}`;
  if (canMark()) performance.mark(end);
  const ms = measure("radlearn:navigation-to-first-preview", navMark, end);
  console.info("[radlearn] viewer first preview", { ms });
}

/**
 * The slice on screen is full-quality (16-bit, W/L and measurement live) for
 * the first time since navigation. On DICOMweb this is the first pixel; on a
 * bundle it is the preview → full swap of the opening slice.
 */
export function markViewerFullQuality(
  navMark: string,
  seriesUID: string,
  source: "bundle" | "dicomweb"
): void {
  const end = `radlearn:full-quality:${navMark}`;
  if (canMark()) performance.mark(end);
  const ms = measure("radlearn:navigation-to-full-quality", navMark, end);
  console.info("[radlearn] viewer full quality", { source, ms });
}
