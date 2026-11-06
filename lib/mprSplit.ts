// Pane sizes of the three-plane MPR layout (components/MprLayout.tsx), as
// shares of the whole that the two splitters move. Pure, so it is unit-tested.

export type Shares = [number, number, number];

/** Smallest share of the layout a plane can be dragged down to. */
export const MIN_SHARE = 0.15;

/** Three equal panes: the default, and what double-click on a splitter (or Home) restores. */
export const EQUAL_SHARES: Shares = [1 / 3, 1 / 3, 1 / 3];

/**
 * Move the boundary between panes `index` and `index + 1` by `delta` (a share
 * of the whole), keeping both panes at least MIN_SHARE and the third as is.
 */
export function moveSplit(shares: readonly [number, number, number], index: 0 | 1, delta: number): Shares {
  const next = [...shares] as Shares;
  const pair = next[index] + next[index + 1];
  const a = Math.min(pair - MIN_SHARE, Math.max(MIN_SHARE, next[index] + delta));
  next[index] = a;
  next[index + 1] = pair - a;
  return next;
}
