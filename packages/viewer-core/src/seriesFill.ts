// Background fill: after the opening slice paints, load the rest of the series
// outward from where the reader is — the nearest slices first, alternating
// above and below — at prefetch priority, so the whole stack (and an MPR
// volume) is local before the reader asks for it.
//
// Bounded by the decoded-image cache: filling past it would evict the slices
// around the reader to make room for the far end. Re-centred when the reader
// settles somewhere new.

/** Indexes ordered by distance from `center` (center excluded), at most `limit`. */
export function outwardOrder(count: number, center: number, limit: number = count): number[] {
  if (!Number.isFinite(count) || count <= 1 || limit <= 0) return [];
  const at = Math.max(0, Math.min(count - 1, Math.round(center)));
  const out: number[] = [];
  for (let d = 1; out.length < limit && (at - d >= 0 || at + d < count); d += 1) {
    if (at + d < count) out.push(at + d);
    if (out.length < limit && at - d >= 0) out.push(at - d);
  }
  return out;
}

/**
 * How many slices the fill may queue: what fits in `share` of the decoded
 * cache. `bytesPerSlice` is rows × columns × bytes per pixel (decoded, not
 * on the wire — JPEG-LS saves bandwidth, not cache).
 */
export function fillBudget(
  count: number,
  bytesPerSlice: number,
  cacheBytes: number,
  share = 0.7
): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!(bytesPerSlice > 0) || !(cacheBytes > 0)) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor((cacheBytes * share) / bytesPerSlice)));
}

/**
 * Run `start` over `items` with at most `concurrency` in flight, in order,
 * until `signal` aborts. Unstarted items are never started after an abort;
 * started ones finish on their own. A synchronous throw or a rejection only
 * skips that item. Resolves when the last started item settles.
 */
export function runBounded<T>(
  items: readonly T[],
  start: (item: T) => Promise<unknown> | void,
  options: { signal: AbortSignal; concurrency: number }
): Promise<void> {
  const { signal } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  let next = 0;
  const lane = async (): Promise<void> => {
    while (!signal.aborted && next < items.length) {
      const item = items[next++];
      try {
        await start(item);
      } catch {
        /* one slice failing never stops the fill */
      }
    }
  };
  return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane)).then(() => undefined);
}
