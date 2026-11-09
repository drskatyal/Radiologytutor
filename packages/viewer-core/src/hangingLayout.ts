// Hanging layouts for the standalone viewer: how many panes, and which series
// each pane opens on.
//
// Pure: the case viewer renders whatever grid this returns. A teaching case
// is small (a handful of series, sometimes a prior and a current), so the
// layouts are the ones a reading room actually reaches for — 1 up, side by
// side, stacked, and a 2×2 — not a configurable protocol engine. The free
// viewer adds the desktop's larger grids (1×3, 2×3, 3×3) for studies with
// many series (`READING_LAYOUTS`).

/** "rows x cols". */
export type HangingLayoutId = "1x1" | "1x2" | "2x1" | "2x2" | "1x3" | "2x3" | "3x3";

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

/**
 * The desktop viewer's seven layouts (its Shift+1…7 order): the case
 * viewer's four plus three across, two rows of three and a 3×3.
 */
export const READING_LAYOUTS: HangingLayout[] = [
  ...HANGING_LAYOUTS,
  { id: "1x3", label: "Three across", cols: 3, rows: 1 },
  { id: "2x3", label: "2 × 3", cols: 3, rows: 2 },
  { id: "3x3", label: "3 × 3", cols: 3, rows: 3 },
];

export function layoutById(id: string | null | undefined): HangingLayout {
  return READING_LAYOUTS.find((l) => l.id === id) ?? READING_LAYOUTS[0]!;
}

/** The layout with exactly this grid, if there is one. */
export function layoutForShape(rows: number, cols: number): HangingLayout | undefined {
  return READING_LAYOUTS.find((l) => l.rows === rows && l.cols === cols);
}

export function paneCount(layout: HangingLayout): number {
  return layout.cols * layout.rows;
}

/**
 * Layouts worth offering for this many series, from `layouts` (the case
 * viewer's four by default). One series still gets side-by-side (same series
 * twice: lung and mediastinal window), but a 2×2 of one series is clutter.
 * Up to four panes are always offered for two or more series; a bigger grid
 * only when there are series to fill it.
 */
export function layoutsForSeriesCount(seriesCount: number, layouts: readonly HangingLayout[] = HANGING_LAYOUTS): HangingLayout[] {
  if (seriesCount <= 0) return [layouts[0]!];
  if (seriesCount === 1) return layouts.filter((l) => paneCount(l) <= 2);
  return layouts.filter((l) => paneCount(l) <= Math.max(4, seriesCount));
}

/**
 * "Open in a new layout pane" (a series thumbnail's menu, as on the desktop):
 * the smallest layout this case offers with more panes than `current`, or
 * null when it is already the largest.
 */
export function layoutWithMorePanes(
  current: HangingLayoutId,
  seriesCount: number,
  layouts: readonly HangingLayout[] = HANGING_LAYOUTS
): HangingLayout | null {
  const now = paneCount(layoutById(current));
  let best: HangingLayout | null = null;
  for (const l of layoutsForSeriesCount(seriesCount, layouts)) {
    const n = paneCount(l);
    if (n > now && (!best || n < paneCount(best))) best = l;
  }
  return best;
}

/** Next layout for the G key, within what this case offers. */
export function nextLayout(current: HangingLayoutId, seriesCount: number, layouts: readonly HangingLayout[] = HANGING_LAYOUTS): HangingLayoutId {
  const offered = layoutsForSeriesCount(seriesCount, layouts);
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

/**
 * Shift+1…7, as on the desktop: the nth reading layout when this study
 * offers it (enough series for its panes), else null.
 */
export function layoutForShortcut(n: number, seriesCount: number): HangingLayout | null {
  const layout = READING_LAYOUTS[n - 1];
  if (!layout) return null;
  return layoutsForSeriesCount(seriesCount, READING_LAYOUTS).some((l) => l.id === layout.id) ? layout : null;
}
