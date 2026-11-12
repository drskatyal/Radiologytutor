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

import type { SketchImageRef } from "./types";

/** Identity and geometry of the image a frame is showing. */
export interface SketchFrameImage extends SketchImageRef {
  plane?: DicomImagePlane;
}

export interface SketchFrame {
  sliceIndex: number;
  /**
   * The image under the camera (SOP, frame, pixel grid, plane). Absent on the
   * fixture page and older callers; teacher sketches then fall back to the
   * stack index alone.
   */
  image?: SketchFrameImage;
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

// ---------------------------------------------------------------------------
// Image-space anchoring for the teacher sketch layer.
//
// Three coordinate systems, one point:
//   • fraction  — x_pct/y_pct in [0,1], the legacy overlay space. Matches the
//                 viewer's projector: index = fraction × (n − 1).
//   • index     — continuous pixel index (col, row); pixel centres are integers.
//   • patient   — DICOM LPS millimetres (PS3.3 C.7.6.2.1.1):
//                 P = IPP + X·Δc·col + Y·Δr·row, where X is the row direction
//                 cosine (increasing column), Y the column direction cosine,
//                 Δc = PixelSpacing[1] (column spacing), Δr = PixelSpacing[0].
//
// DICOM SR SCOORD and GSPS PIXEL units put 0.0\0.0 at the top-left CORNER of
// the top-left pixel, so a pixel centre at index 0 is 0.5 there.
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

/** The DICOM Image Plane module, as Cornerstone's `imagePlaneModule` reports it. */
export interface DicomImagePlane {
  imagePositionPatient: Vec3;
  /** Direction of increasing column index (first triplet of ImageOrientationPatient). */
  rowCosines: Vec3;
  /** Direction of increasing row index (second triplet). */
  columnCosines: Vec3;
  /** DICOM PixelSpacing: [row spacing (vertical), column spacing (horizontal)] in mm. */
  pixelSpacing: [number, number];
  columns: number;
  rows: number;
}

export interface ImageIndex {
  col: number;
  row: number;
}

export function fractionToIndex(xPct: number, yPct: number, columns: number, rows: number): ImageIndex | null {
  if (![xPct, yPct, columns, rows].every(Number.isFinite) || columns < 1 || rows < 1) return null;
  return { col: xPct * Math.max(1, columns - 1), row: yPct * Math.max(1, rows - 1) };
}

export function indexToFraction(col: number, row: number, columns: number, rows: number): { x_pct: number; y_pct: number } | null {
  if (![col, row, columns, rows].every(Number.isFinite) || columns < 1 || rows < 1) return null;
  return { x_pct: col / Math.max(1, columns - 1), y_pct: row / Math.max(1, rows - 1) };
}

function spacingOf(plane: DicomImagePlane): { dr: number; dc: number } {
  const dr = plane.pixelSpacing[0] > 0 ? plane.pixelSpacing[0] : 1;
  const dc = plane.pixelSpacing[1] > 0 ? plane.pixelSpacing[1] : dr;
  return { dr, dc };
}

function validPlane(plane: DicomImagePlane | null | undefined): plane is DicomImagePlane {
  if (!plane) return false;
  const nums = [...plane.imagePositionPatient, ...plane.rowCosines, ...plane.columnCosines];
  return nums.length === 9 && nums.every(Number.isFinite);
}

/** Pixel index → patient mm. Null when the plane is incomplete. */
export function indexToPatient(col: number, row: number, plane: DicomImagePlane | null | undefined): Vec3 | null {
  if (!validPlane(plane) || !Number.isFinite(col) || !Number.isFinite(row)) return null;
  const { dr, dc } = spacingOf(plane);
  const out: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    out[axis] =
      plane.imagePositionPatient[axis] +
      plane.rowCosines[axis] * dc * col +
      plane.columnCosines[axis] * dr * row;
  }
  return out;
}

/**
 * Patient mm → pixel index on this plane (orthogonal projection, so a point a
 * little off-plane lands on its nearest in-plane pixel). Assumes orthonormal
 * cosines, which DICOM requires.
 */
export function patientToIndex(mm: Vec3, plane: DicomImagePlane | null | undefined): ImageIndex | null {
  if (!validPlane(plane) || !mm.every(Number.isFinite)) return null;
  const { dr, dc } = spacingOf(plane);
  const d: Vec3 = [
    mm[0] - plane.imagePositionPatient[0],
    mm[1] - plane.imagePositionPatient[1],
    mm[2] - plane.imagePositionPatient[2],
  ];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { col: dot(d, plane.rowCosines) / dc, row: dot(d, plane.columnCosines) / dr };
}

/** Pixel index → SR SCOORD / GSPS PIXEL coordinate (corner origin). */
export function indexToScoord(col: number, row: number): [number, number] {
  return [col + 0.5, row + 0.5];
}

/** SR SCOORD / GSPS PIXEL coordinate → pixel index. */
export function scoordToIndex(x: number, y: number): ImageIndex {
  return { col: x - 0.5, row: y - 0.5 };
}
