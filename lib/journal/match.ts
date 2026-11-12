import type { ViewerSnapshot } from "./types";

export const VIEW_TOLERANCE = { voi: 0.5, zoom: 0.005, pan: 0.5, rotation: 0.1, orientation: 0.0001 } as const;
const near = (a: number, b: number, epsilon: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
export function matchesView(actual: ViewerSnapshot, target: ViewerSnapshot): boolean {
  if (["studyUID", "seriesUID", "sopUID", "frame", "viewportId", "layout", "invert"].some(key => actual[key as keyof ViewerSnapshot] !== target[key as keyof ViewerSnapshot])) return false;
  if (!near(actual.voi.ww, target.voi.ww, VIEW_TOLERANCE.voi) || !near(actual.voi.wc, target.voi.wc, VIEW_TOLERANCE.voi)) return false;
  const a = actual.camera, b = target.camera;
  if (a.flipH !== b.flipH || a.flipV !== b.flipV || !near(a.zoom, b.zoom, VIEW_TOLERANCE.zoom) || !near(a.rotation, b.rotation, VIEW_TOLERANCE.rotation)) return false;
  if (!a.pan.every((n, i) => near(n, b.pan[i], VIEW_TOLERANCE.pan))) return false;
  return ["normal", "up"].every(key => {
    const x = actual.orientation[key as "normal" | "up"], y = target.orientation[key as "normal" | "up"];
    return x.length === 3 && y.length === 3 && x.every((n, i) => near(n, y[i], VIEW_TOLERANCE.orientation));
  });
}
