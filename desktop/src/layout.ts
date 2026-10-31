// Hanging: which series goes in which viewport when the grid changes.

/**
 * Fill a resized grid: keep what is already on screen (in place), then hang
 * the series not yet shown, in browser order. Shrinking drops trailing cells.
 */
export function hangSeries(previous: readonly (string | null)[], size: number, order: readonly string[]): (string | null)[] {
  const next = Array.from({ length: size }, (_, i) => previous[i] ?? null);
  const shown = new Set(next.filter(Boolean));
  const queue = order.filter((uid) => !shown.has(uid));
  for (let i = 0; i < next.length; i += 1) {
    if (!next[i] && queue.length) next[i] = queue.shift()!;
  }
  return next;
}
