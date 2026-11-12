// Curved and cross-curved MPR geometry.
//
// The reader places control points on any (oblique) plane, scrolling between
// clicks to follow a structure out of plane, so the centreline is a true 3D
// curve. It is smoothed with a centripetal Catmull-Rom spline (passes through
// every control point, no loops or overshoot between uneven clicks) and
// resampled every `stepMm` of arc length.
//
// Frames along the curve are rotation-minimising (double reflection, Wang et
// al. 2008), seeded with the drawing plane's normal: a curve drawn on one
// plane keeps that normal as "up" everywhere (the classic stretched CPR, e.g.
// a panoramic mandible from an axial curve), and a 3D curve does not twist.
// `rotationDeg` turns the whole sheet about the centreline.
//
//   straightened CPR   columns along the curve (arc length, mm), rows along
//                      up; slab across the sheet (lateral)
//   cross-section      the plane perpendicular to the curve at arc length s:
//                      right = tangent × up, down = −up, slab along the tangent

import { add, cross, dot, norm, normalize, rotate, scale, sub, type Vec3 } from "./geometry";
import type { ColumnGrid, PlaneGrid, Projection } from "./sampler";

/** Centripetal Catmull-Rom through `points`, `perSegment` samples per span. */
export function catmullRom(points: readonly Vec3[], perSegment = 16): Vec3[] {
  const pts = points.filter((p, i) => i === 0 || norm(sub(p, points[i - 1])) > 1e-6);
  if (pts.length < 3) return pts.slice();
  const out: Vec3[] = [pts[0]];
  const ext = [sub(scale(pts[0], 2), pts[1]), ...pts, sub(scale(pts[pts.length - 1], 2), pts[pts.length - 2])];
  const tj = (a: Vec3, b: Vec3) => Math.max(1e-6, Math.sqrt(norm(sub(b, a))));
  for (let s = 1; s < ext.length - 2; s += 1) {
    const [p0, p1, p2, p3] = [ext[s - 1], ext[s], ext[s + 1], ext[s + 2]];
    const t0 = 0;
    const t1 = t0 + tj(p0, p1);
    const t2 = t1 + tj(p1, p2);
    const t3 = t2 + tj(p2, p3);
    for (let n = 1; n <= perSegment; n += 1) {
      const t = t1 + ((t2 - t1) * n) / perSegment;
      const lerp = (a: Vec3, b: Vec3, ta: number, tb: number): Vec3 => add(scale(a, (tb - t) / (tb - ta)), scale(b, (t - ta) / (tb - ta)));
      const a1 = lerp(p0, p1, t0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  return out;
}

/** Length (mm) of the polyline through `points`. */
export function polylineLengthMm(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += norm(sub(points[i], points[i - 1]));
  return total;
}

/** Points every `stepMm` of arc length along a polyline (first and last kept). */
export function resampleByArc(points: readonly Vec3[], stepMm: number): { points: Vec3[]; arc: number[] } {
  if (points.length < 2 || !(stepMm > 0)) return { points: points.slice(), arc: points.map(() => 0) };
  const out: Vec3[] = [points[0]];
  const arc: number[] = [0];
  let walked = 0;
  let next = stepMm;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const seg = sub(points[i], a);
    const len = norm(seg);
    if (len === 0) continue;
    while (next <= walked + len + 1e-9) {
      out.push(add(a, scale(seg, (next - walked) / len)));
      arc.push(next);
      next += stepMm;
    }
    walked += len;
  }
  if (walked - arc[arc.length - 1] > stepMm * 0.25) {
    out.push(points[points.length - 1]);
    arc.push(walked);
  }
  return { points: out, arc };
}

export interface CurveFrames {
  points: Vec3[];
  tangents: Vec3[];
  /** Unit up (CPR rows, cross-section −down). */
  up: Vec3[];
  /** Unit up × tangent: the CPR slab direction. */
  lateral: Vec3[];
  /** Arc length (mm) of each sample. */
  arc: number[];
  lengthMm: number;
  stepMm: number;
}

function perpendicularTo(t: Vec3, hint: Vec3): Vec3 {
  let r = sub(hint, scale(t, dot(hint, t)));
  if (norm(r) < 1e-6) {
    // Hint along the curve: any perpendicular (least-aligned axis).
    const axis: Vec3 = Math.abs(t[0]) < 0.6 ? [1, 0, 0] : Math.abs(t[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
    r = sub(axis, scale(t, dot(axis, t)));
  }
  return normalize(r);
}

/**
 * Frames every `stepMm` along the smoothed curve through `control`.
 * `upHint`: the drawing plane's normal. Throws below two distinct points.
 */
export function curveFrames(control: readonly Vec3[], stepMm: number, upHint: Vec3, rotationDeg = 0): CurveFrames {
  const smooth = catmullRom(control);
  if (smooth.length < 2) throw new Error("A curve needs at least two points.");
  const { points, arc } = resampleByArc(smooth, stepMm);
  if (points.length < 2) throw new Error("The curve is too short.");
  const n = points.length;
  const tangents: Vec3[] = points.map((_, i) => normalize(sub(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)])));
  const up: Vec3[] = new Array(n);
  up[0] = perpendicularTo(tangents[0], upHint);
  for (let i = 0; i < n - 1; i += 1) {
    const v1 = sub(points[i + 1], points[i]);
    const c1 = dot(v1, v1);
    if (c1 < 1e-12) {
      up[i + 1] = up[i];
      continue;
    }
    const rL = sub(up[i], scale(v1, (2 / c1) * dot(v1, up[i])));
    const tL = sub(tangents[i], scale(v1, (2 / c1) * dot(v1, tangents[i])));
    const v2 = sub(tangents[i + 1], tL);
    const c2 = dot(v2, v2);
    const r = c2 < 1e-12 ? rL : sub(rL, scale(v2, (2 / c2) * dot(v2, rL)));
    up[i + 1] = perpendicularTo(tangents[i + 1], r);
  }
  const rad = (rotationDeg * Math.PI) / 180;
  const turned = rad ? up.map((u, i) => normalize(rotate(u, tangents[i], rad))) : up;
  const lateral = turned.map((u, i) => normalize(cross(u, tangents[i])));
  return { points, tangents, up: turned, lateral, arc, lengthMm: arc[n - 1], stepMm };
}

/** Straightened CPR: `halfHeightMm` each side of the centreline. */
export function straightenedGrid(f: CurveFrames, halfHeightMm: number, slab?: { mode: Projection; thicknessMm: number }): ColumnGrid {
  return {
    kind: "columns",
    points: f.points,
    up: f.up,
    lateral: f.lateral,
    rowStepMm: f.stepMm,
    halfRows: Math.max(1, Math.round(halfHeightMm / f.stepMm)),
    slab: slab && slab.thicknessMm > 0 ? slab : undefined,
  };
}

/** Frame at arc length `s` (clamped), interpolated between samples. */
export function frameAt(f: CurveFrames, s: number): { point: Vec3; tangent: Vec3; up: Vec3; right: Vec3; index: number } {
  const t = Math.min(Math.max(s, 0), f.lengthMm);
  let i = Math.min(f.points.length - 2, Math.max(0, Math.floor(t / f.stepMm)));
  while (i < f.points.length - 2 && f.arc[i + 1] < t) i += 1;
  const span = f.arc[i + 1] - f.arc[i] || 1;
  const w = Math.min(1, Math.max(0, (t - f.arc[i]) / span));
  const mix = (a: Vec3, b: Vec3): Vec3 => add(scale(a, 1 - w), scale(b, w));
  const tangent = normalize(mix(f.tangents[i], f.tangents[i + 1]));
  const up = perpendicularTo(tangent, mix(f.up[i], f.up[i + 1]));
  return { point: mix(f.points[i], f.points[i + 1]), tangent, up, right: normalize(cross(tangent, up)), index: w < 0.5 ? i : i + 1 };
}

/** Cross-section perpendicular to the curve at `s`: `sizeMm` square, `pixelMm` per pixel. */
export function crossSectionGrid(
  f: CurveFrames,
  s: number,
  sizeMm: number,
  pixelMm: number,
  slab?: { mode: Projection; thicknessMm: number }
): PlaneGrid & { center: Vec3; right: Vec3; down: Vec3 } {
  const fr = frameAt(f, s);
  const n = Math.max(8, Math.round(sizeMm / pixelMm));
  const du = scale(fr.right, pixelMm);
  const down = scale(fr.up, -1);
  const dv = scale(down, pixelMm);
  const origin = sub(sub(fr.point, scale(du, (n - 1) / 2)), scale(dv, (n - 1) / 2));
  return {
    kind: "plane",
    origin,
    du,
    dv,
    width: n,
    height: n,
    slab: slab && slab.thicknessMm > 0 ? { ...slab, normal: fr.tangent } : undefined,
    center: fr.point,
    right: fr.right,
    down,
  };
}

/** Patient position of CPR pixel (column x, row y). */
export function cprPixelToPatient(f: CurveFrames, grid: ColumnGrid, x: number, y: number): Vec3 {
  const c = Math.min(f.points.length - 1, Math.max(0, Math.round(x)));
  return add(f.points[c], scale(f.up[c], (grid.halfRows - y) * grid.rowStepMm));
}

/** Arc positions of `count` cross-sections centred on `s`, `intervalMm` apart, inside the curve. */
export function crossSectionStations(f: CurveFrames, s: number, count: number, intervalMm: number): number[] {
  const half = (count - 1) / 2;
  return Array.from({ length: count }, (_, i) => s + (i - half) * intervalMm).filter((x) => x >= 0 && x <= f.lengthMm + 1e-6);
}

// ───────────── control-point editing (pure) ─────────────

export function movePoint(points: readonly Vec3[], index: number, to: Vec3): Vec3[] {
  return points.map((p, i) => (i === index ? to : p));
}

export function removePoint(points: readonly Vec3[], index: number): Vec3[] {
  return points.filter((_, i) => i !== index);
}

function segmentDistance(q: Vec3, a: Vec3, b: Vec3): { d: number; t: number } {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 ? Math.min(1, Math.max(0, dot(sub(q, a), ab) / len2)) : 0;
  return { d: norm(sub(q, add(a, scale(ab, t)))), t };
}

/**
 * Insert `q` where it belongs: inside the nearest segment, or before the
 * first / after the last point when it lies beyond an end.
 */
export function insertPoint(points: readonly Vec3[], q: Vec3): Vec3[] {
  if (points.length < 2) return [...points, q];
  let best = { d: Infinity, at: points.length };
  for (let i = 1; i < points.length; i += 1) {
    const { d, t } = segmentDistance(q, points[i - 1], points[i]);
    if (d < best.d) best = { d, at: t <= 0 && i === 1 ? 0 : t >= 1 && i === points.length - 1 ? points.length : i };
  }
  const out = points.slice();
  out.splice(best.at, 0, q);
  return out;
}
