// Hanging layouts in the free viewer (/viewer): which study + series each pane
// shows. A drop can hold several studies (a prior and a current), so a pane
// is addressed by (study, series), flattened in the order the series panel
// lists them. The grid itself and the "keep what is hung, fill new panes with
// series nobody shows yet" rule come from the viewer core (hangingLayout.ts).

import { hangSeries, layoutById, type HangingLayout, type HangingLayoutId } from "@flowrad/viewer-core";

export interface PaneSeries {
  study: number;
  series: number;
}

/** Every series of every study, in the series panel's order. */
export function flattenSeries(studies: readonly { series: readonly unknown[] }[]): PaneSeries[] {
  return studies.flatMap((study, s) => study.series.map((_, i) => ({ study: s, series: i })));
}

export function samePane(a: PaneSeries | undefined, b: PaneSeries | undefined): boolean {
  return !!a && !!b && a.study === b.study && a.series === b.series;
}

/**
 * Re-hang after the layout or the study changed. `previous[0]` is the main
 * pane (it always keeps what it shows); the other panes keep their series
 * where it still exists and otherwise take series nobody is showing yet.
 */
export function hangLocal(layout: HangingLayout, flat: readonly PaneSeries[], previous: readonly PaneSeries[]): PaneSeries[] {
  if (flat.length === 0) return [];
  const indexOf = (p: PaneSeries | undefined) => (p ? flat.findIndex((f) => samePane(f, p)) : -1);
  const prev = previous.map(indexOf);
  const main = prev[0] != null && prev[0] >= 0 ? prev[0] : 0;
  return hangSeries(layout, flat.length, [main, ...prev.slice(1).map((i) => (i >= 0 ? i : -1))], main).map((i) => flat[i]!);
}

/** A voice "layout one / two / four" (rows × columns) as a hanging layout. */
export function layoutForGrid(rows: number, cols: number): HangingLayoutId {
  if (rows >= 2 && cols >= 2) return "2x2";
  if (cols >= 2) return "1x2";
  if (rows >= 2) return "2x1";
  return "1x1";
}

export { layoutById };
