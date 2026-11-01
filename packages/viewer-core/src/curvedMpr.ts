// Curved MPR (straightened curved-planar reformation).
//
// The reader clicks a centreline on one MPR plane (a vessel, a ureter, the
// spine, a mandible). The curve is resampled at even arc-length steps; for each
// step we sample the volume along the drawing plane's normal, so the output
// image's columns run along the curve and its rows through the slab around it.
// Pure: the caller supplies `sample(world) → value` (the volume, in any engine).

export type Point3 = readonly [number, number, number];

export interface CurvedMprRequest {
  /** Centreline in patient mm, in drawing order (≥ 2 points). */
  points: readonly Point3[];
  /** Unit normal of the plane the curve was drawn on: the output's vertical axis. */
  normal: Point3;
  /** Half-height of the output along the normal (mm). */
  halfHeightMm: number;
  /** Output pixel size (mm) along the curve and the normal; usually the volume's in-plane spacing. */
  stepMm: number;
  sample: (world: Point3) => number;
}

export interface CurvedMprImage {
  width: number;
  height: number;
  /** Row-major, top row = +normal side. NaN outside the volume. */
  values: Float32Array;
  /** Arc length of the curve (mm). */
  lengthMm: number;
  /** Centreline point for each output column (for linking a click back to the volume). */
  columns: Point3[];
}

const sub = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Point3, b: Point3): Point3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Point3, s: number): Point3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Point3) => Math.hypot(a[0], a[1], a[2]);

/** Points every `stepMm` along the polyline (first and last included). */
export function resamplePolyline(points: readonly Point3[], stepMm: number): Point3[] {
  if (points.length < 2 || !(stepMm > 0)) return points.slice();
  const out: Point3[] = [points[0]];
  let carried = 0; // distance already walked since the last emitted point
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const seg = sub(points[i], a);
    const segLen = len(seg);
    if (segLen === 0) continue;
    const dir = scale(seg, 1 / segLen);
    let t = stepMm - carried;
    while (t <= segLen + 1e-9) {
      out.push(add(a, scale(dir, t)));
      t += stepMm;
    }
    carried = segLen - (t - stepMm);
  }
  const last = points[points.length - 1];
  if (len(sub(out[out.length - 1], last)) > stepMm * 0.25) out.push(last);
  return out;
}

export function polylineLength(points: readonly Point3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += len(sub(points[i], points[i - 1]));
  return total;
}

export function curvedMpr(req: CurvedMprRequest): CurvedMprImage {
  const columns = resamplePolyline(req.points, req.stepMm);
  const n = len(req.normal) || 1;
  const normal = scale(req.normal, 1 / n);
  const half = Math.max(1, Math.round(req.halfHeightMm / req.stepMm));
  const height = half * 2 + 1;
  const width = columns.length;
  const values = new Float32Array(width * height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const offset = (half - y) * req.stepMm; // top row = +normal
      const v = req.sample(add(columns[x], scale(normal, offset)));
      values[y * width + x] = Number.isFinite(v) ? v : Number.NaN;
    }
  }
  return { width, height, values, lengthMm: polylineLength(req.points), columns };
}

/** Window a curved image to 8-bit greyscale RGBA for a canvas (NaN → black). */
export function curvedMprToRgba(img: CurvedMprImage, ww: number, wc: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(img.width * img.height * 4));
  const lo = wc - ww / 2;
  for (let i = 0; i < img.values.length; i += 1) {
    const v = img.values[i];
    const g = Number.isNaN(v) ? 0 : Math.max(0, Math.min(255, ((v - lo) / Math.max(1, ww)) * 255));
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g;
    out[i * 4 + 3] = 255;
  }
  return out;
}
