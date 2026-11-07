// Patient-space geometry of a reconstructed volume (DICOM LPS, millimetres).
//
// Shared by every reconstruction (multi-oblique planes, slabs, curved and
// cross-curved MPR) on web and desktop. Index space is (i, j, k) = (column,
// row, slice); patient space is DICOM LPS: +x Left, +y Posterior, +z Head.
//
//   patient = origin + i·sx·axes[0] + j·sy·axes[1] + k·sz·axes[2]
//
// axes[0] is the Image Orientation (Patient) row cosine (direction of
// increasing column index), axes[1] the column cosine (increasing row index),
// axes[2] the measured slice-to-slice step direction. axes[2] is NOT assumed
// to be the cross product of the first two: a gantry-tilted acquisition steps
// obliquely, and taking the true step keeps those volumes in the right place.
// Spacing may differ on every axis (anisotropic data).

export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
};
/** Rotate `v` about the unit axis `k` by `rad` (Rodrigues). */
export function rotate(v: Vec3, k: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
}

export interface VolumeGeometry {
  /** Voxels along i (columns), j (rows), k (slices). */
  dims: [number, number, number];
  /** Millimetres per voxel along i, j, k. */
  spacing: [number, number, number];
  /** Patient position (mm) of voxel (0, 0, 0)'s centre. */
  origin: Vec3;
  /** Unit patient directions of +i, +j, +k. */
  axes: [Vec3, Vec3, Vec3];
}

/** Patient position of a (fractional) voxel index. */
export function indexToPatient(g: VolumeGeometry, ijk: Vec3): Vec3 {
  const [sx, sy, sz] = g.spacing;
  const [a, b, c] = g.axes;
  return [
    g.origin[0] + ijk[0] * sx * a[0] + ijk[1] * sy * b[0] + ijk[2] * sz * c[0],
    g.origin[1] + ijk[0] * sx * a[1] + ijk[1] * sy * b[1] + ijk[2] * sz * c[1],
    g.origin[2] + ijk[0] * sx * a[2] + ijk[1] * sy * b[2] + ijk[2] * sz * c[2],
  ];
}

/**
 * Row-major 3×3 matrix taking (patient − origin) to a fractional index. The
 * columns of the forward matrix are axes[n]·spacing[n]; this is its inverse,
 * which handles non-orthogonal (tilted) slice steps exactly.
 */
export function patientToIndexMatrix(g: VolumeGeometry): number[] {
  const m = [0, 1, 2].map((r) => [0, 1, 2].map((c) => g.axes[c][r] * g.spacing[c]));
  const [[a, b, c], [d, e, f], [h, i, k]] = m;
  const det = a * (e * k - f * i) - b * (d * k - f * h) + c * (d * i - e * h);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error("Degenerate volume geometry.");
  const inv = [
    e * k - f * i, c * i - b * k, b * f - c * e,
    f * h - d * k, a * k - c * h, c * d - a * f,
    d * i - e * h, b * h - a * i, a * e - b * d,
  ];
  return inv.map((v) => v / det);
}

export function patientToIndex(g: VolumeGeometry, p: Vec3, inv = patientToIndexMatrix(g)): Vec3 {
  const d = sub(p, g.origin);
  return [
    inv[0] * d[0] + inv[1] * d[1] + inv[2] * d[2],
    inv[3] * d[0] + inv[4] * d[1] + inv[5] * d[2],
    inv[6] * d[0] + inv[7] * d[1] + inv[8] * d[2],
  ];
}

/** Patient-space centre of the volume. */
export function volumeCenter(g: VolumeGeometry): Vec3 {
  return indexToPatient(g, [(g.dims[0] - 1) / 2, (g.dims[1] - 1) / 2, (g.dims[2] - 1) / 2]);
}

/** Longest patient-space extent of the volume (mm): a field of view that fits it. */
export function volumeDiagonalMm(g: VolumeGeometry): number {
  return Math.hypot(g.dims[0] * g.spacing[0], g.dims[1] * g.spacing[1], g.dims[2] * g.spacing[2]);
}

/** Smallest voxel spacing: the natural output pixel / slab step. */
export function finestSpacing(g: VolumeGeometry): number {
  return Math.min(g.spacing[0], g.spacing[1], g.spacing[2]);
}

export interface SliceGeometryInput {
  /** Image Position (Patient), mm. */
  position: readonly number[];
  /** Image Orientation (Patient): row cosine then column cosine. */
  orientation: readonly number[];
  /** Pixel Spacing in DICOM order: [row spacing, column spacing] (mm). */
  pixelSpacing: readonly number[];
  rows: number;
  columns: number;
}

export interface SliceOrder {
  geometry: VolumeGeometry;
  /** Input indices in volume order (k = 0 first). */
  order: number[];
}

/**
 * Volume geometry from per-slice DICOM headers. Slices are ordered along the
 * plane normal; the slice step is measured from the first to the last
 * position (so a tilted gantry's oblique step is kept). Throws with a
 * reader-facing message when the slices cannot form one regular volume.
 */
export function geometryFromSlices(slices: readonly SliceGeometryInput[]): SliceOrder {
  if (slices.length < 2) throw new Error("A volume needs at least two slices.");
  const first = slices[0];
  if (first.orientation.length < 6 || first.position.length < 3) throw new Error("The slices have no position or orientation.");
  const row = normalize([first.orientation[0], first.orientation[1], first.orientation[2]]);
  const col = normalize([first.orientation[3], first.orientation[4], first.orientation[5]]);
  const normal = normalize(cross(row, col));
  if (norm(normal) === 0) throw new Error("The image orientation is degenerate.");
  for (const s of slices) {
    if (s.rows !== first.rows || s.columns !== first.columns) throw new Error("The slices differ in size, so they cannot form a volume.");
    const r: Vec3 = [s.orientation[0], s.orientation[1], s.orientation[2]];
    const c: Vec3 = [s.orientation[3], s.orientation[4], s.orientation[5]];
    if (Math.abs(dot(normalize(r), row)) < 0.999 || Math.abs(dot(normalize(c), col)) < 0.999) {
      throw new Error("The slices are not all in the same orientation.");
    }
  }
  const pos = (i: number): Vec3 => [slices[i].position[0], slices[i].position[1], slices[i].position[2]];
  const order = slices.map((_, i) => i).sort((a, b) => dot(pos(a), normal) - dot(pos(b), normal));
  const n = order.length;
  const total = sub(pos(order[n - 1]), pos(order[0]));
  const span = norm(total);
  if (!(span > 1e-6)) throw new Error("The slices share one position, so they cannot form a volume.");
  const step = span / (n - 1);
  // Regular spacing: every gap within 10 % of the mean (rounded positions).
  for (let i = 1; i < n; i += 1) {
    const gap = norm(sub(pos(order[i]), pos(order[i - 1])));
    if (Math.abs(gap - step) > Math.max(0.1 * step, 0.01)) {
      throw new Error("The slices are unevenly spaced (a gap or overlap), so they cannot form one volume.");
    }
  }
  const sliceAxis = normalize(total);
  if (Math.abs(dot(sliceAxis, normal)) < 0.5) throw new Error("The slices step almost within their own plane.");
  const sx = Number(first.pixelSpacing[1]) || 1;
  const sy = Number(first.pixelSpacing[0]) || 1;
  return {
    order,
    geometry: {
      dims: [first.columns, first.rows, n],
      spacing: [sx, sy, step],
      origin: pos(order[0]),
      axes: [row, col, sliceAxis],
    },
  };
}

/**
 * The geometry after box-reducing a volume by `xy` in-plane and `z` along the
 * slices (memory budget): voxel centres move to the centre of each block.
 */
export function reducedGeometry(g: VolumeGeometry, xy: number, z: number): VolumeGeometry {
  if (xy === 1 && z === 1) return g;
  const shift = indexToPatient(g, [(xy - 1) / 2, (xy - 1) / 2, (z - 1) / 2]);
  return {
    dims: [Math.floor(g.dims[0] / xy), Math.floor(g.dims[1] / xy), Math.floor(g.dims[2] / z)],
    spacing: [g.spacing[0] * xy, g.spacing[1] * xy, g.spacing[2] * z],
    origin: shift,
    axes: g.axes,
  };
}

/**
 * Patient-axis letters for a direction (LPS; "L", "PH", …): strongest axis
 * first, a second letter when that component is ≥ 0.3. Same letters and rule
 * as dicomOverlay's orientationLetters (H / F for head / feet).
 */
export function directionLetters(v: Vec3): string {
  const letters: [string, string][] = [
    ["L", "R"],
    ["P", "A"],
    ["H", "F"],
  ];
  if (!v.every(Number.isFinite)) return "";
  const parts = [0, 1, 2].map((a) => ({ letter: v[a] >= 0 ? letters[a][0] : letters[a][1], weight: Math.abs(v[a]) })).sort((a, b) => b.weight - a.weight);
  if (parts[0].weight < 1e-3) return "";
  return parts[1].weight >= 0.3 ? parts[0].letter + parts[1].letter : parts[0].letter;
}

export interface EdgeLetters {
  top: string;
  bottom: string;
  left: string;
  right: string;
}

/** Edge letters of an image whose +x (right) is `u` and +y (down) is `v`. */
export function edgeLetters(u: Vec3, v: Vec3): EdgeLetters {
  return {
    right: directionLetters(u),
    left: directionLetters(scale(u, -1)),
    bottom: directionLetters(v),
    top: directionLetters(scale(v, -1)),
  };
}

const CARDINAL: { name: "axial" | "coronal" | "sagittal"; normal: Vec3 }[] = [
  { name: "axial", normal: [0, 0, 1] },
  { name: "coronal", normal: [0, 1, 0] },
  { name: "sagittal", normal: [1, 0, 0] },
];

/**
 * What a plane with this normal is, for the pane title: "Axial" within half a
 * degree of a cardinal plane, otherwise "Oblique · 23° from axial" (angle to
 * the nearest cardinal plane).
 */
export function planeName(normal: Vec3): { base: "axial" | "coronal" | "sagittal"; degrees: number; label: string } {
  const n = normalize(normal);
  let best = CARDINAL[0];
  let bestCos = -1;
  for (const c of CARDINAL) {
    const cos = Math.abs(dot(n, c.normal));
    if (cos > bestCos) {
      bestCos = cos;
      best = c;
    }
  }
  const degrees = (Math.acos(Math.min(1, bestCos)) * 180) / Math.PI;
  const title = best.name[0].toUpperCase() + best.name.slice(1);
  return {
    base: best.name,
    degrees,
    label: degrees < 0.5 ? title : `Oblique · ${degrees.toFixed(degrees < 10 ? 1 : 0)}° from ${best.name}`,
  };
}
