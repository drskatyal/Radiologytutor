/**
 * Image-fraction geometry for the sketch layer.
 *
 * A mark is stored on the slice (0–1 across the pixel grid), then projected
 * through the live camera. Zoom and pan move the screen point. They do not
 * move the image point, so the stroke stays on the anatomy.
 *
 * Cornerstone's stack viewport is the live projector (index → world → canvas).
 * `projectImageNorm` is the same idea for tests and the fixture page: a fitted
 * image, uniform scale, pan in canvas pixels.
 */

export interface StackCamera {
  columns: number;
  rows: number;
  canvasWidth: number;
  canvasHeight: number;
  /** Canvas pixels per image pixel when zoom is 1 (the fit). */
  fitScale: number;
  zoom: number;
  panX: number;
  panY: number;
}

export interface SketchFrame {
  sliceIndex: number;
  width: number;
  height: number;
  project: (xPct: number, yPct: number) => { x: number; y: number } | null;
  unproject: (x: number, y: number) => { x_pct: number; y_pct: number } | null;
}

export interface ImagePlane {
  origin: readonly [number, number, number];
  rowCosines: readonly [number, number, number];
  columnCosines: readonly [number, number, number];
  rowSpacing: number;
  columnSpacing: number;
  columns: number;
  rows: number;
}

function finitePoint(x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Fit scale that letterboxes `columns × rows` inside the canvas. */
export function fitScaleFor(columns: number, rows: number, canvasWidth: number, canvasHeight: number): number {
  if (columns < 2 || rows < 2 || canvasWidth < 2 || canvasHeight < 2) return 1;
  return Math.min(canvasWidth / (columns - 1), canvasHeight / (rows - 1));
}

export function projectImageNorm(
  xPct: number,
  yPct: number,
  camera: StackCamera
): { x: number; y: number } | null {
  if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) return null;
  const scale = camera.fitScale * (camera.zoom > 0 ? camera.zoom : 1);
  const imgX = xPct * Math.max(1, camera.columns - 1);
  const imgY = yPct * Math.max(1, camera.rows - 1);
  const cx = camera.canvasWidth / 2 + camera.panX;
  const cy = camera.canvasHeight / 2 + camera.panY;
  const originX = cx - ((camera.columns - 1) * scale) / 2;
  const originY = cy - ((camera.rows - 1) * scale) / 2;
  return finitePoint(originX + imgX * scale, originY + imgY * scale);
}

export function unprojectImageNorm(
  canvasX: number,
  canvasY: number,
  camera: StackCamera
): { x_pct: number; y_pct: number } | null {
  const scale = camera.fitScale * (camera.zoom > 0 ? camera.zoom : 1);
  if (!(scale > 0)) return null;
  const cx = camera.canvasWidth / 2 + camera.panX;
  const cy = camera.canvasHeight / 2 + camera.panY;
  const originX = cx - ((camera.columns - 1) * scale) / 2;
  const originY = cy - ((camera.rows - 1) * scale) / 2;
  const xPct = (canvasX - originX) / ((camera.columns - 1) * scale);
  const yPct = (canvasY - originY) / ((camera.rows - 1) * scale);
  if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) return null;
  return { x_pct: xPct, y_pct: yPct };
}

export function frameFromCamera(camera: StackCamera, sliceIndex: number): SketchFrame {
  return {
    sliceIndex,
    width: camera.canvasWidth,
    height: camera.canvasHeight,
    project: (x, y) => projectImageNorm(x, y, camera),
    unproject: (x, y) => unprojectImageNorm(x, y, camera),
  };
}

/**
 * DICOM image fraction → patient coordinates.
 * Matches Cornerstone `imageToWorldCoords`: column/row cosines, half-pixel origin.
 */
export function imageFractionToWorld(
  xPct: number,
  yPct: number,
  plane: ImagePlane
): [number, number, number] | null {
  if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) return null;
  if (!(plane.columns > 1) || !(plane.rows > 1)) return null;
  const col = xPct * (plane.columns - 1);
  const row = yPct * (plane.rows - 1);
  const rowSpacing = plane.rowSpacing > 0 ? plane.rowSpacing : 1;
  const columnSpacing = plane.columnSpacing > 0 ? plane.columnSpacing : 1;
  const world: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    world[axis] =
      plane.origin[axis] +
      plane.rowCosines[axis] * rowSpacing * (col - 0.5) +
      plane.columnCosines[axis] * columnSpacing * (row - 0.5);
  }
  return world;
}

export function placeCardBox(
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
  card: { width: number; height: number }
): { x: number; y: number } {
  const margin = 16;
  const maxX = Math.max(margin, viewport.width - card.width - margin);
  const maxY = Math.max(margin, viewport.height - card.height - margin);
  // Findings on the left get the card on the right, so an arrow from the
  // upper left is not covered by the label.
  const preferRight = anchor.x < viewport.width * 0.48;
  let x = preferRight ? anchor.x + 36 : anchor.x - card.width - 18;
  let y = anchor.y - Math.round(card.height * 0.55);
  if (x < margin) x = anchor.x + 28;
  if (x > maxX) x = anchor.x - card.width - 18;
  if (y < margin) y = anchor.y + 20;
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(margin, y)),
  };
}

/** Point on the card border closest to the anatomy anchor, for the leader. */
export function leaderStart(
  card: { x: number; y: number; width: number; height: number },
  anchor: { x: number; y: number }
): { x: number; y: number } {
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  const dx = anchor.x - cx;
  const dy = anchor.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: card.y + card.height };
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : card.width / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : card.height / 2 / Math.abs(dy);
  const scale = Math.min(sx, sy);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

export function cardPixelSize(viewportWidth: number): { width: number; height: number } {
  const width = Math.min(248, Math.max(148, Math.round(viewportWidth * 0.68)));
  return { width, height: 168 };
}
