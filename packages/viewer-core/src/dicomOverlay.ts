// DICOM corner overlay — what a reading room expects in the four corners of
// the viewport, and the orientation letters on its edges.
//
// Pure: metadata + view state in, display lines out. The viewer reads the
// metadata off Cornerstone's provider and renders whatever this returns.
//
// PHI: this is an ALLOW-LIST. Only series-level technical fields are read —
// modality, series description/number, slice geometry, matrix. Patient name,
// ID, birth date, accession, institution, operator and study dates are never
// accepted by these types, so they cannot reach the screen even on a study
// that skipped de-identification (docs/UI_AUDIT.md backlog #12).

export type OverlayDensity = "full" | "basic" | "off";

/** Cycle order for the overlay toggle (O key / toolbar button). */
export const OVERLAY_DENSITIES: OverlayDensity[] = ["full", "basic", "off"];

export const OVERLAY_STORAGE_KEY = "flowrad.viewer.overlay";

export function nextOverlayDensity(current: OverlayDensity): OverlayDensity {
  const i = OVERLAY_DENSITIES.indexOf(current);
  return OVERLAY_DENSITIES[(i + 1) % OVERLAY_DENSITIES.length] ?? "full";
}

export function parseOverlayDensity(value: unknown): OverlayDensity {
  return value === "basic" || value === "off" || value === "full" ? value : "full";
}

/** Series-level technical metadata. Nothing patient-identifying fits here. */
export interface OverlayMeta {
  modality?: string | null;
  seriesDescription?: string | null;
  seriesNumber?: number | string | null;
  sliceThickness?: number | null;
  sliceLocation?: number | null;
  rows?: number | null;
  columns?: number | null;
  /** Six direction cosines: row (x,y,z) then column (x,y,z). */
  imageOrientationPatient?: ArrayLike<number> | null;
}

export interface OverlayView {
  /** 1-based slice shown. */
  slice: number;
  count: number;
  ww?: number;
  wc?: number;
  /** Cornerstone zoom (1 = fit). */
  zoom?: number;
  /** Named window preset, when the current window is one. */
  presetLabel?: string | null;
  /** "Axial" while MPR is on screen. */
  plane?: string | null;
  inverted?: boolean;
  /** Frames per second while cine is playing. */
  cineFps?: number | null;
}

export interface OverlayCorners {
  topLeft: string[];
  topRight: string[];
  bottomLeft: string[];
  bottomRight: string[];
}

const EMPTY: OverlayCorners = { topLeft: [], topRight: [], bottomLeft: [], bottomRight: [] };

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** −45.25 → "−45.3". A real minus sign so the column of numbers lines up. */
export function formatSigned(n: number, digits = 1): string {
  const fixed = Math.abs(n).toFixed(digits);
  return n < 0 && Number(fixed) !== 0 ? `−${fixed}` : fixed;
}

function formatMm(n: number): string {
  // 1.25 stays 1.25, 5 stays 5, 0.625 → 0.63. Trailing zeros dropped.
  return `${Number(n.toFixed(2))} mm`;
}

export function windowLine(ww?: number, wc?: number): string | null {
  if (!finite(ww) || !finite(wc)) return null;
  return `W ${Math.round(ww)}  L ${formatSigned(Math.round(wc), 0)}`;
}

/**
 * Lines for each corner. `basic` keeps only the two numbers a teacher names
 * out loud — slice and window — so a recording or a projector stays clean.
 */
export function overlayCorners(
  meta: OverlayMeta | null | undefined,
  view: OverlayView | null | undefined,
  density: OverlayDensity = "full"
): OverlayCorners {
  if (!view || density === "off") return EMPTY;
  const m = meta ?? {};
  const slice = `${view.plane ? `${view.plane}  ` : ""}Im ${view.slice} / ${view.count}`;
  const wl = windowLine(view.ww, view.wc);

  if (density === "basic") {
    return {
      topLeft: [],
      topRight: [slice],
      bottomLeft: wl ? [wl] : [],
      bottomRight: [],
    };
  }

  const topLeft: string[] = [];
  const description = (m.seriesDescription ?? "").trim();
  if (description) topLeft.push(description.slice(0, 48));
  const modality = (m.modality ?? "").trim().toUpperCase();
  const seriesNo =
    m.seriesNumber != null && String(m.seriesNumber).trim() !== ""
      ? `Se ${String(m.seriesNumber).trim()}`
      : "";
  const kind = [modality, seriesNo].filter(Boolean).join("  ·  ");
  if (kind) topLeft.push(kind);

  const topRight: string[] = [slice];
  const geometry: string[] = [];
  if (finite(m.sliceThickness) && m.sliceThickness > 0) {
    geometry.push(`Th ${formatMm(m.sliceThickness)}`);
  }
  if (finite(m.sliceLocation)) geometry.push(`Loc ${formatSigned(m.sliceLocation)}`);
  if (geometry.length) topRight.push(geometry.join("  "));

  const bottomLeft: string[] = [];
  if (wl) bottomLeft.push(view.presetLabel ? `${wl}  ${view.presetLabel}` : wl);
  if (view.inverted) bottomLeft.push("Inverted");

  const bottomRight: string[] = [];
  if (finite(view.cineFps) && view.cineFps > 0) bottomRight.push(`Cine ${view.cineFps} fps`);
  if (finite(view.zoom) && view.zoom > 0) bottomRight.push(`Zoom ${Math.round(view.zoom * 100)}%`);
  if (finite(m.columns) && finite(m.rows) && m.columns > 0 && m.rows > 0) {
    bottomRight.push(`${m.columns} × ${m.rows}`);
  }

  return { topLeft, topRight, bottomLeft, bottomRight };
}

// --- Orientation markers ---------------------------------------------------
// DICOM patient space is LPS: +x toward the patient's Left, +y Posterior,
// +z Head (superior). A direction cosine names the side it points to.

const AXIS_LETTERS: [positive: string, negative: string][] = [
  ["L", "R"],
  ["P", "A"],
  ["H", "F"],
];

/**
 * Letters for one direction, strongest axis first. A secondary axis is named
 * only when the plane is clearly oblique (> ~17°), so a true axial reads
 * "L" and not "LPH" from rounding noise in the header.
 */
export function orientationLetters(vector: ArrayLike<number>, obliqueMin = 0.3): string {
  const parts: { letter: string; weight: number }[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const value = Number(vector[axis]);
    if (!Number.isFinite(value)) return "";
    const [pos, neg] = AXIS_LETTERS[axis]!;
    parts.push({ letter: value >= 0 ? pos : neg, weight: Math.abs(value) });
  }
  parts.sort((a, b) => b.weight - a.weight);
  const [first, second] = parts;
  if (!first || first.weight < 1e-3) return "";
  return second && second.weight >= obliqueMin ? first.letter + second.letter : first.letter;
}

export interface OrientationMarkers {
  top: string;
  bottom: string;
  left: string;
  right: string;
}

/**
 * Edge letters from ImageOrientationPatient. The row cosine points to the
 * RIGHT edge of the displayed image, the column cosine to the BOTTOM edge.
 * Null when the header has no usable orientation (a radiograph, a secondary
 * capture) — better no letters than wrong ones.
 */
export function orientationMarkers(
  iop: ArrayLike<number> | null | undefined
): OrientationMarkers | null {
  if (!iop || iop.length < 6) return null;
  const values = Array.from({ length: 6 }, (_, i) => Number(iop[i]));
  if (values.some((v) => !Number.isFinite(v))) return null;
  const row = values.slice(0, 3);
  const col = values.slice(3, 6);
  const neg = (v: number[]) => v.map((x) => -x);
  const markers = {
    right: orientationLetters(row),
    left: orientationLetters(neg(row)),
    bottom: orientationLetters(col),
    top: orientationLetters(neg(col)),
  };
  if (!markers.right || !markers.bottom) return null;
  return markers;
}
