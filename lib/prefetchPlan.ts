// Which slices to warm, and when.
//
// The viewer had ONE prefetch rule: on a 200 ms scroll pause, warm a
// symmetric ±8 window around the current slice (`lib/viewerLoad.ts`
// `neighborIndexes`). That is correct for a reader who stops to look, and
// useless for the thing readers actually do — hold the wheel and travel.
// During travel the pause timer never fires, so every slice is a cold
// round trip and the stack scrolls at network latency.
//
// This module adds the second rule, the one every PACS has: while the reader
// is MOVING, warm a short window in the DIRECTION of travel. It is small on
// purpose (a handful of ids at `prefetch` priority) so it can be issued on
// every slice change without competing with the slice the reader is landing on.
// The symmetric pause-warm still runs; the two are complementary:
//
//   moving  → `directionalPrefetchIndexes` — cheap, ahead-biased, every slice
//   stopped → `neighborIndexes(radius)`    — wide, symmetric, once
//
// And the pause radius is no longer a constant 8. A 30-slice knee MR is
// 15 MB; warming all of it makes the whole series instantly scrollable. A
// 1200-slice CTA must stay a window or the cache thrashes and the browser
// spends its decode budget on slices nobody will reach.
//
// Pure arithmetic. No Cornerstone, no network — `lib/progressiveStack.ts`
// turns these indexes into load requests.

/** Slices warmed ahead of the reader while a scroll is in progress. */
export const TRAVEL_AHEAD = 5;
/** Slices kept behind the reader while travelling (for a direction reversal). */
export const TRAVEL_BEHIND = 1;

/**
 * Pause-warm radius for a series of `count` images.
 *
 * ≤ 64 frames    the whole series (a single MR/CR series, ~32 MB of pixels)
 * ≤ 320 frames   ±16 (a routine chest/abdomen CT — a full wheel sweep ahead)
 * otherwise      ±12 (a CTA / thin-slice volume; keep the cache a window)
 *
 * The large-series radius is intentionally lower than the mid one: a reader
 * on a 1000-slice volume travels further per gesture, so the *directional*
 * warm carries the load and a wide symmetric window would only evict it.
 */
export function prefetchRadiusFor(count: number): number {
  if (!Number.isFinite(count) || count <= 1) return 0;
  if (count <= 64) return count;
  if (count <= 320) return 16;
  return 12;
}

export interface ScrollDirectionState {
  /** Last index this state saw. `null` before the first sample. */
  last: number | null;
  /** +1 scrolling toward the end of the stack, -1 toward the start, 0 unknown. */
  direction: -1 | 0 | 1;
}

export function createScrollDirectionState(): ScrollDirectionState {
  return { last: null, direction: 0 };
}

/**
 * Feed the current slice index; get the travel direction. A repeat of the
 * same index keeps the previous direction (a re-render is not a stop), and
 * the first sample has no direction yet.
 */
export function trackScrollDirection(
  state: ScrollDirectionState,
  index: number
): -1 | 0 | 1 {
  if (!Number.isFinite(index)) return state.direction;
  const at = Math.round(index);
  if (state.last == null) {
    state.last = at;
    return state.direction;
  }
  if (at === state.last) return state.direction;
  state.direction = at > state.last ? 1 : -1;
  state.last = at;
  return state.direction;
}

/**
 * Indexes to warm while travelling: `TRAVEL_AHEAD` in the direction of
 * travel, then `TRAVEL_BEHIND` the other way, nearest first so the queue
 * drains in the order the reader will need them. `center` itself is excluded —
 * it is already an interaction request.
 *
 * `direction` 0 (no travel yet) returns the forward window, because a stack
 * opens mid-series and the first gesture is more often "down the chest".
 */
export function directionalPrefetchIndexes(
  count: number,
  center: number,
  direction: -1 | 0 | 1,
  ahead: number = TRAVEL_AHEAD,
  behind: number = TRAVEL_BEHIND
): number[] {
  if (!Number.isFinite(count) || count <= 1) return [];
  const at = Math.max(0, Math.min(count - 1, Math.round(center)));
  const sign = direction === -1 ? -1 : 1;
  const out: number[] = [];
  const push = (index: number) => {
    if (index < 0 || index > count - 1 || index === at || out.includes(index)) return;
    out.push(index);
  };
  for (let step = 1; step <= Math.max(0, Math.floor(ahead)); step += 1) {
    push(at + sign * step);
  }
  for (let step = 1; step <= Math.max(0, Math.floor(behind)); step += 1) {
    push(at - sign * step);
  }
  return out;
}
