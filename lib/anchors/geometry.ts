/** DICOM geometry, in original image pixels. No renderer-supplied 1 mm defaults. */
export type Vec3 = [number, number, number];
export type ImagePoint = { x: number; y: number };
export type Calibration = "PixelSpacing" | "ImagerPixelSpacing" | "uncalibrated";
export interface ImageGeometry {
  calibration: Calibration;
  /** DICOM row spacing, column spacing, in mm. */
  spacing: [number, number] | null;
  origin: Vec3 | null;
  orientation: [number, number, number, number, number, number] | null;
  positionSource: "per-frame" | "instance" | "missing";
  frameOfReferenceUID?: string;
}
const values = (raw: unknown, tag: string): unknown[] => (raw as Record<string, { Value?: unknown[] }> | undefined)?.[tag]?.Value ?? [];
const sequence = (raw: unknown, tag: string) => values(raw, tag)[0];
const nums = (raw: unknown, tag: string, n: number): number[] | null => {
  const v = values(raw, tag).map(Number);
  return v.length === n && v.every(Number.isFinite) ? v : null;
};
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
export function validGeometry(g: ImageGeometry | undefined): g is ImageGeometry {
  if (!g || !["PixelSpacing", "ImagerPixelSpacing", "uncalibrated"].includes(g.calibration)) return false;
  if (g.calibration !== "uncalibrated" && (!Array.isArray(g.spacing) || g.spacing.length !== 2 || !g.spacing.every(n => Number.isFinite(n) && n > 0))) return false;
  if (g.origin && (!Array.isArray(g.origin) || g.origin.length !== 3 || !g.origin.every(Number.isFinite))) return false;
  if (g.orientation) {
    if (!Array.isArray(g.orientation) || g.orientation.length !== 6 || !g.orientation.every(Number.isFinite)) return false;
    const a = g.orientation.slice(0, 3), b = g.orientation.slice(3);
    if (Math.abs(dot(a, a) - 1) > 1e-4 || Math.abs(dot(b, b) - 1) > 1e-4 || Math.abs(dot(a, b)) > 1e-4) return false;
  }
  return true;
}
export const uncalibratedGeometry = (): ImageGeometry => ({ calibration: "uncalibrated", spacing: null, origin: null, orientation: null, positionSource: "missing" });
export function geometryFromDicom(raw: unknown, frame: number): ImageGeometry {
  const count = Number(values(raw, "00280008")[0] ?? 1);
  if (!Number.isInteger(frame) || frame < 1 || frame > count) return uncalibratedGeometry();
  const perFrame = values(raw, "52009230")[frame - 1];
  const shared = sequence(raw, "52009229");
  const measures = sequence(perFrame, "00289110") ?? sequence(shared, "00289110");
  // An explicitly invalid PixelSpacing does not fall through to another spacing.
  const pixelOwner = values(measures, "00280030").length ? measures : raw;
  const pixel = values(pixelOwner, "00280030").length > 0;
  const spacing = nums(pixel ? pixelOwner : raw, pixel ? "00280030" : "00181164", 2);
  const calibrated = spacing?.every(n => n > 0) ?? false;
  const perPosition = nums(sequence(perFrame, "00209113"), "00200032", 3);
  const origin = perPosition ?? (count === 1 ? nums(raw, "00200032", 3) : null);
  const orientation = nums(sequence(perFrame, "00209116") ?? sequence(shared, "00209116"), "00200037", 6) ?? nums(raw, "00200037", 6);
  const g: ImageGeometry = {
    calibration: calibrated ? (pixel ? "PixelSpacing" : "ImagerPixelSpacing") : "uncalibrated",
    spacing: calibrated ? spacing as [number, number] : null,
    origin: origin as Vec3 | null, orientation: orientation as ImageGeometry["orientation"],
    positionSource: perPosition ? "per-frame" : origin ? "instance" : "missing",
    ...(typeof values(raw, "00200052")[0] === "string" ? { frameOfReferenceUID: values(raw, "00200052")[0] as string } : {}),
  };
  return validGeometry(g) ? g : uncalibratedGeometry();
}
export function pixelToPatient(p: ImagePoint, g: ImageGeometry): Vec3 | null {
  if (!validGeometry(g) || g.calibration === "uncalibrated" || !g.spacing || !g.origin || !g.orientation || ![p.x, p.y].every(Number.isFinite)) return null;
  return g.origin.map((v, i) => v + p.x * g.spacing![1] * g.orientation![i] + p.y * g.spacing![0] * g.orientation![i + 3]) as Vec3;
}
export function patientToPixel(p: Vec3, g: ImageGeometry): ImagePoint | null {
  if (!validGeometry(g) || g.calibration === "uncalibrated" || !g.spacing || !g.origin || !g.orientation || !p.every(Number.isFinite)) return null;
  const delta = p.map((v, i) => v - g.origin![i]);
  const a = g.orientation.slice(0, 3), b = g.orientation.slice(3);
  // Invert the two basis vectors without assuming perfect decimal orthogonality.
  const aa = dot(a, a), ab = dot(a, b), bb = dot(b, b), det = aa * bb - ab * ab;
  const da = dot(delta, a), db = dot(delta, b);
  const result = { x: (da * bb - db * ab) / det / g.spacing[1], y: (db * aa - da * ab) / det / g.spacing[0] };
  const restored = pixelToPatient(result, g)!;
  return Math.hypot(...restored.map((v, i) => v - p[i])) <= 1e-6 ? result : null;
}
export function measuredLength(points: ImagePoint[], g: ImageGeometry): number | null {
  if (points.length !== 2) return null;
  const [a, b] = points.map(p => pixelToPatient(p, g));
  return a && b ? Math.hypot(...a.map((v, i) => v - b[i])) : null;
}
