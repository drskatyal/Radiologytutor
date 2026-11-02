// Hanging layouts for the standalone viewer: how many panes, and which series
// each pane opens on.
//
// Pure: the case viewer renders whatever grid this returns. A teaching case
// is small (a handful of series, sometimes a prior and a current), so the
// layouts are the ones a reading room actually reaches for — 1 up, side by
// side, stacked, and a 2×2 — not a configurable protocol engine.

export type HangingLayoutId = "1x1" | "1x2" | "2x1" | "2x2";

export interface HangingLayout {
  id: HangingLayoutId;
  label: string;
  cols: number;
  rows: number;
}

export const HANGING_LAYOUTS: HangingLayout[] = [
  { id: "1x1", label: "Single", cols: 1, rows: 1 },
  { id: "1x2", label: "Side by side", cols: 2, rows: 1 },
  { id: "2x1", label: "Stacked", cols: 1, rows: 2 },
  { id: "2x2", label: "2 × 2", cols: 2, rows: 2 },
];

export function layoutById(id: string | null | undefined): HangingLayout {
  return HANGING_LAYOUTS.find((l) => l.id === id) ?? HANGING_LAYOUTS[0]!;
}

export function paneCount(layout: HangingLayout): number {
  return layout.cols * layout.rows;
}

/**
 * Layouts worth offering for this many series. One series still gets
 * side-by-side (same series twice: lung and mediastinal window), but a 2×2 of
 * one series is clutter.
 */
export function layoutsForSeriesCount(seriesCount: number): HangingLayout[] {
  if (seriesCount <= 0) return [HANGING_LAYOUTS[0]!];
  if (seriesCount === 1) return HANGING_LAYOUTS.filter((l) => paneCount(l) <= 2);
  return HANGING_LAYOUTS;
}

/** Next layout for the G key, within what this case offers. */
export function nextLayout(current: HangingLayoutId, seriesCount: number): HangingLayoutId {
  const offered = layoutsForSeriesCount(seriesCount);
  const i = offered.findIndex((l) => l.id === current);
  return offered[(i + 1) % offered.length]!.id;
}

/**
 * Series index for every pane. Keeps what the reader already hung where it
 * still fits, then fills new panes with the series nobody is showing yet, in
 * rail order, wrapping when the case has fewer series than panes.
 */
export function hangSeries(
  layout: HangingLayout,
  seriesCount: number,
  previous: readonly number[] = [],
  activeSeries = 0
): number[] {
  const n = paneCount(layout);
  if (seriesCount <= 0) return Array.from({ length: n }, () => 0);
  const valid = (i: number | undefined): i is number =>
    typeof i === "number" && Number.isInteger(i) && i >= 0 && i < seriesCount;
  const out: number[] = [];
  const first = valid(previous[0]) ? previous[0] : valid(activeSeries) ? activeSeries : 0;
  out.push(first);
  for (let pane = 1; pane < n; pane += 1) {
    const kept = previous[pane];
    if (valid(kept)) {
      out.push(kept);
      continue;
    }
    let pick = -1;
    for (let k = 0; k < seriesCount; k += 1) {
      const candidate = (first + k) % seriesCount;
      if (!out.includes(candidate)) {
        pick = candidate;
        break;
      }
    }
    out.push(pick >= 0 ? pick : out[out.length - 1]!);
  }
  return out;
}

/** Arrow-key move between panes; stays put at an edge. */
export function movePane(
  layout: HangingLayout,
  pane: number,
  direction: "left" | "right" | "up" | "down"
): number {
  const col = pane % layout.cols;
  const row = Math.floor(pane / layout.cols);
  const next = {
    left: [Math.max(0, col - 1), row],
    right: [Math.min(layout.cols - 1, col + 1), row],
    up: [col, Math.max(0, row - 1)],
    down: [col, Math.min(layout.rows - 1, row + 1)],
  }[direction] as [number, number];
  return next[1] * layout.cols + next[0];
}
