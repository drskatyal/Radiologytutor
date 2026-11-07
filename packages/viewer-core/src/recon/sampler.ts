// The reconstruction sampler: values of a volume on a grid in patient space.
//
// Two grid shapes cover every reconstruction:
//   plane    an affine grid (multi-oblique planes, curved-MPR cross-sections),
//            optionally projected through a slab along the plane normal;
//   columns  one frame per output column (straightened curved MPR): rows run
//            along each column's `up`, the slab along its `lateral`.
//
// Interpolation is trilinear in index space, so anisotropic and oblique
// volumes resample in true millimetres. Outside the volume is NaN (drawn
// black, never mistaken for tissue). The desktop shell implements the same
// contract in Rust (src-tauri/src/reslice.rs) over its native volume; both
// are tested against the same synthetic volumes.

import { finestSpacing, patientToIndexMatrix, sub, type Vec3, type VolumeGeometry } from "./geometry";

export type Projection = "mip" | "minip" | "avg";

export interface Slab {
  mode: Projection;
  /** Full slab thickness (mm). ≤ one step means a single sample. */
  thicknessMm: number;
}

export interface ReconVolume {
  geometry: VolumeGeometry;
  /** Modality values, index (k·ny + j)·nx + i. */
  data: ArrayLike<number>;
}

export interface PlaneGrid {
  kind: "plane";
  /** Patient position of pixel (0, 0)'s centre. */
  origin: Vec3;
  /** Patient step (mm vector) per output column and per output row. */
  du: Vec3;
  dv: Vec3;
  width: number;
  height: number;
  /** Projection through `thicknessMm` along the unit `normal`, centred on the plane. */
  slab?: Slab & { normal: Vec3 };
}

export interface ColumnGrid {
  kind: "columns";
  /** One centreline point per column (patient mm). */
  points: readonly Vec3[];
  /** Unit "up" per column: row 0 is +halfRows·rowStepMm along it. */
  up: readonly Vec3[];
  /** Unit lateral per column (the slab direction). */
  lateral: readonly Vec3[];
  rowStepMm: number;
  halfRows: number;
  slab?: Slab;
}

export type SampleGrid = PlaneGrid | ColumnGrid;

export interface ReconImage {
  width: number;
  height: number;
  /** Row-major; NaN outside the volume. */
  values: Float32Array;
}

export function gridSize(grid: SampleGrid): { width: number; height: number } {
  return grid.kind === "plane"
    ? { width: grid.width, height: grid.height }
    : { width: grid.points.length, height: grid.halfRows * 2 + 1 };
}

/** Largest grid we sample (memory and time bound): 4096 × 4096. */
export const MAX_GRID_PIXELS = 4096 * 4096;
/** Most samples through one slab. */
export const MAX_SLAB_SAMPLES = 512;

/** Offsets (mm) of the slab samples, centred on 0, `step` apart. */
export function slabOffsets(thicknessMm: number, stepMm: number): number[] {
  if (!(thicknessMm > stepMm) || !(stepMm > 0)) return [0];
  const count = Math.min(MAX_SLAB_SAMPLES, Math.floor(thicknessMm / stepMm) + 1);
  const span = (count - 1) * stepMm;
  return Array.from({ length: count }, (_, i) => -span / 2 + i * stepMm);
}

/** Trilinear value at a fractional index, or NaN beyond half a voxel outside. */
export function trilinearAt(vol: ReconVolume, i: number, j: number, k: number): number {
  const [nx, ny, nz] = vol.geometry.dims;
  if (!(i >= -0.5 && j >= -0.5 && k >= -0.5 && i <= nx - 0.5 && j <= ny - 0.5 && k <= nz - 0.5)) return Number.NaN;
  const x = Math.min(Math.max(i, 0), nx - 1);
  const y = Math.min(Math.max(j, 0), ny - 1);
  const z = Math.min(Math.max(k, 0), nz - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = x0 + 1 < nx ? x0 + 1 : x0;
  const y1 = y0 + 1 < ny ? y0 + 1 : y0;
  const z1 = z0 + 1 < nz ? z0 + 1 : z0;
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const d = vol.data;
  const plane = nx * ny;
  const a = z0 * plane;
  const b = z1 * plane;
  const r00 = a + y0 * nx;
  const r01 = a + y1 * nx;
  const r10 = b + y0 * nx;
  const r11 = b + y1 * nx;
  const c00 = d[r00 + x0] * (1 - fx) + d[r00 + x1] * fx;
  const c01 = d[r01 + x0] * (1 - fx) + d[r01 + x1] * fx;
  const c10 = d[r10 + x0] * (1 - fx) + d[r10 + x1] * fx;
  const c11 = d[r11 + x0] * (1 - fx) + d[r11 + x1] * fx;
  const c0 = c00 * (1 - fy) + c01 * fy;
  const c1 = c10 * (1 - fy) + c11 * fy;
  return c0 * (1 - fz) + c1 * fz;
}

const mul = (m: number[], v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

function project(vol: ReconVolume, i: number, j: number, k: number, step: Vec3 | null, offsets: number[], mode: Projection): number {
  if (!step || offsets.length === 1) return trilinearAt(vol, i, j, k);
  let acc = mode === "mip" ? -Infinity : mode === "minip" ? Infinity : 0;
  let n = 0;
  for (const o of offsets) {
    const v = trilinearAt(vol, i + step[0] * o, j + step[1] * o, k + step[2] * o);
    if (Number.isNaN(v)) continue;
    n += 1;
    if (mode === "mip") acc = v > acc ? v : acc;
    else if (mode === "minip") acc = v < acc ? v : acc;
    else acc += v;
  }
  if (n === 0) return Number.NaN;
  return mode === "avg" ? acc / n : acc;
}

/** Fill rows [y0, y1) of `out` (row-major, width `w`). */
function sampleRows(vol: ReconVolume, grid: SampleGrid, inv: number[], y0: number, y1: number, out: Float32Array): void {
  const g = vol.geometry;
  const stepMm = finestSpacing(g);
  if (grid.kind === "plane") {
    const { width } = grid;
    const o = mul(inv, sub(grid.origin, g.origin));
    const di = mul(inv, grid.du);
    const dj = mul(inv, grid.dv);
    const slab = grid.slab;
    const offsets = slab ? slabOffsets(slab.thicknessMm, stepMm) : [0];
    const dn = slab ? mul(inv, slab.normal) : null;
    const mode = slab?.mode ?? "avg";
    for (let y = y0; y < y1; y += 1) {
      const ri = o[0] + dj[0] * y;
      const rj = o[1] + dj[1] * y;
      const rk = o[2] + dj[2] * y;
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        out[row + x] = project(vol, ri + di[0] * x, rj + di[1] * x, rk + di[2] * x, dn, offsets, mode);
      }
    }
    return;
  }
  const width = grid.points.length;
  const half = grid.halfRows;
  const offsets = grid.slab ? slabOffsets(grid.slab.thicknessMm, stepMm) : [0];
  const mode = grid.slab?.mode ?? "avg";
  for (let x = 0; x < width; x += 1) {
    const p = mul(inv, sub(grid.points[x], g.origin));
    const u = mul(inv, grid.up[x]);
    const l = grid.slab ? mul(inv, grid.lateral[x]) : null;
    for (let y = y0; y < y1; y += 1) {
      const t = (half - y) * grid.rowStepMm; // row 0 = +up
      out[y * width + x] = project(vol, p[0] + u[0] * t, p[1] + u[1] * t, p[2] + u[2] * t, l, offsets, mode);
    }
  }
}

function checkGrid(grid: SampleGrid): { width: number; height: number } {
  const size = gridSize(grid);
  if (!(size.width >= 1 && size.height >= 1) || size.width * size.height > MAX_GRID_PIXELS) {
    throw new Error(`Reconstruction grid ${size.width}×${size.height} is out of range.`);
  }
  if (grid.kind === "columns" && (grid.up.length !== size.width || grid.lateral.length !== size.width)) {
    throw new Error("Curved grid: one up and one lateral vector per column.");
  }
  return size;
}

/** Sample the whole grid now (tests, workers). */
export function sampleGridSync(vol: ReconVolume, grid: SampleGrid): ReconImage {
  const { width, height } = checkGrid(grid);
  const values = new Float32Array(width * height);
  sampleRows(vol, grid, patientToIndexMatrix(vol.geometry), 0, height, values);
  return { width, height, values };
}

export class ReconCancelled extends Error {
  constructor() {
    super("Reconstruction superseded");
    this.name = "ReconCancelled";
  }
}

/**
 * Sample in row bands, yielding to the event loop between bands so a drag
 * stays responsive; a newer request aborts this one through `signal`
 * (rejects with ReconCancelled).
 */
export async function sampleGrid(
  vol: ReconVolume,
  grid: SampleGrid,
  opts: { signal?: AbortSignal; bandRows?: number; yieldFn?: () => Promise<void> } = {}
): Promise<ReconImage> {
  const { width, height } = checkGrid(grid);
  const values = new Float32Array(width * height);
  const inv = patientToIndexMatrix(vol.geometry);
  const band = Math.max(1, opts.bandRows ?? Math.max(8, Math.floor(65536 / Math.max(1, width))));
  const yieldNow = opts.yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  for (let y = 0; y < height; y += band) {
    if (opts.signal?.aborted) throw new ReconCancelled();
    sampleRows(vol, grid, inv, y, Math.min(height, y + band), values);
    if (y + band < height) await yieldNow();
  }
  if (opts.signal?.aborted) throw new ReconCancelled();
  return { width, height, values };
}

/** Window a reconstruction to RGBA (NaN = black). */
export function windowToRgba(img: ReconImage, ww: number, wc: number, invert = false): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(img.width * img.height * 4));
  const lo = wc - ww / 2;
  const k = 255 / Math.max(1e-6, ww);
  for (let p = 0; p < img.values.length; p += 1) {
    const v = img.values[p];
    let g = Number.isNaN(v) ? 0 : (v - lo) * k;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    if (invert && !Number.isNaN(v)) g = 255 - g;
    const o = p * 4;
    out[o] = g;
    out[o + 1] = g;
    out[o + 2] = g;
    out[o + 3] = 255;
  }
  return out;
}
