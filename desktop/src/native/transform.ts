// Phase 2, P2.2: the image ↔ cell transform of a native viewport — the same
// math as desktop/src-tauri/src/native_view.rs (Transform::to_cell /
// to_image) and the native fragment shader. Rust returns the transform with
// every view; the page uses it to draw overlays (annotations, reference
// lines, the probe) in image coordinates. Both sides test the same numbers.

export interface NativeTransform {
  /** CSS px per image pixel (fit × zoom). */
  scale: number;
  /** Image centre in the cell, CSS px. */
  center: [number, number];
  cos: number;
  sin: number;
  flipX: number;
  flipY: number;
  cols: number;
  rows: number;
}

export interface NativeView {
  index: number;
  wl: [number, number];
  zoom: number;
  pan: [number, number];
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  invert: boolean;
}

/** Image pixel (col, row) → cell CSS px. */
export function toCell(t: NativeTransform, col: number, row: number): [number, number] {
  const fx = (col - t.cols / 2) * t.scale * t.flipX;
  const fy = (row - t.rows / 2) * t.scale * t.flipY;
  return [t.center[0] + t.cos * fx - t.sin * fy, t.center[1] + t.sin * fx + t.cos * fy];
}

/** Cell CSS px → image pixel (col, row). */
export function toImage(t: NativeTransform, x: number, y: number): [number, number] {
  const dx = x - t.center[0];
  const dy = y - t.center[1];
  const fx = t.cos * dx + t.sin * dy;
  const fy = -t.sin * dx + t.cos * dy;
  return [(fx * t.flipX) / t.scale + t.cols / 2, (fy * t.flipY) / t.scale + t.rows / 2];
}

/** Same as native_view.rs Transform::new (for tests and optimistic drawing). */
export function transformFor(view: NativeView, cols: number, rows: number, cellW: number, cellH: number): NativeTransform {
  const turned = view.rotation % 180 === 90;
  const [iw, ih] = turned ? [rows, cols] : [cols, rows];
  const fit = Math.min(cellW / Math.max(iw, 1), cellH / Math.max(ih, 1));
  const [sin, cos] = view.rotation === 90 ? [1, 0] : view.rotation === 180 ? [0, -1] : view.rotation === 270 ? [-1, 0] : [0, 1];
  return {
    scale: fit * view.zoom,
    center: [cellW / 2 + view.pan[0], cellH / 2 + view.pan[1]],
    cos,
    sin,
    flipX: view.flipH ? -1 : 1,
    flipY: view.flipV ? -1 : 1,
    cols,
    rows,
  };
}
