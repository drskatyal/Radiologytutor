// Shared, client-only signals between the viewport and the series rail.
// Counts published here come from the DICOMweb instance list the viewer
// actually loaded. The rail reads them instead of a stale stored zero.

export interface SeriesCountSnapshot {
  counts: ReadonlyMap<string, number>;
}

const EMPTY: SeriesCountSnapshot = { counts: new Map() };
let snapshot: SeriesCountSnapshot = EMPTY;
const countListeners = new Set<() => void>();

let pixelsReady = false;
const pixelListeners = new Set<() => void>();

export function publishSeriesImageCount(seriesInstanceUID: string, count: number): void {
  if (!seriesInstanceUID || !Number.isFinite(count) || count <= 0) return;
  if (snapshot.counts.get(seriesInstanceUID) === count) return;
  const counts = new Map(snapshot.counts);
  counts.set(seriesInstanceUID, count);
  snapshot = { counts };
  countListeners.forEach((listener) => listener());
}

export function getSeriesCounts(): SeriesCountSnapshot {
  return snapshot;
}

export function getServerSeriesCounts(): SeriesCountSnapshot {
  return EMPTY;
}

export function subscribeSeriesCounts(listener: () => void): () => void {
  countListeners.add(listener);
  return () => countListeners.delete(listener);
}

/** Primary viewer is about to fetch. Thumbnails wait so they cannot steal the first frame. */
export function beginViewerNavigation(instanceId: string): void {
  if (instanceId !== "primary") return;
  pixelsReady = false;
}

export function markViewerPixels(instanceId: string): void {
  if (instanceId !== "primary") return;
  if (pixelsReady) return;
  pixelsReady = true;
  pixelListeners.forEach((listener) => listener());
}

export function primaryPixelsPainted(): boolean {
  return pixelsReady;
}

export function subscribeViewerPixels(listener: () => void): () => void {
  pixelListeners.add(listener);
  return () => pixelListeners.delete(listener);
}
