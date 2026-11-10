// Assemble a reconstruction volume from decoded slices, within a memory budget.
//
// The web viewer builds it from slices its image loader already decodes; the
// desktop shell builds its own in Rust (src-tauri/src/volume.rs) with the same
// reduction ladder. Values are modality values (rescale applied). Int16 when
// every value is an integer in range (CT, most MR), else Float32 (PET, scaled
// MR). Over budget, slices are averaged in pairs first, then 2×2 in-plane.

import { geometryFromSlices, reducedGeometry, type SliceGeometryInput, type VolumeGeometry } from "./geometry";
import { ReconCancelled, type ReconVolume } from "./sampler";

export interface SliceSource extends SliceGeometryInput {
  /** Modality values of this slice (row-major, rows × columns). */
  values: () => Promise<ArrayLike<number>>;
}

/** Same ladder as the desktop's `volume::reduction`: least lossy first. */
export function reductionFor(cols: number, rows: number, slices: number, bytesPerVoxel: number, budget: number): [number, number] {
  const bytes = (xy: number, z: number) => Math.floor(cols / xy) * Math.floor(rows / xy) * Math.floor(slices / z) * bytesPerVoxel;
  const ladder: [number, number][] = [[1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [2, 4], [4, 2], [4, 4]];
  for (const [xy, z] of ladder) if (Math.floor(slices / z) >= 3 && bytes(xy, z) <= budget) return [xy, z];
  return [4, 4];
}

export interface BuiltVolume extends ReconVolume {
  /** [in-plane, slice] reduction (1 = full resolution). */
  reduced: [number, number];
  bytes: number;
  min: number;
  max: number;
}

const fitsInt16 = (v: ArrayLike<number>) => {
  for (let i = 0; i < v.length; i += 97) {
    const x = v[i];
    if (!Number.isInteger(x) || x < -32768 || x > 32767) return false;
  }
  return true;
};

export async function buildReconVolume(
  slices: readonly SliceSource[],
  opts: { budgetBytes: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }
): Promise<BuiltVolume> {
  const { geometry, order } = geometryFromSlices(slices);
  const [nx, ny, nz] = geometry.dims;
  // Peek at the middle slice for the value type.
  const middle = await slices[order[Math.floor(nz / 2)]].values();
  const int16 = fitsInt16(middle);
  const bpv = int16 ? 2 : 4;
  const [xy, z] = reductionFor(nx, ny, nz, bpv, opts.budgetBytes);
  const g: VolumeGeometry = reducedGeometry(geometry, xy, z);
  const [ox, oy, oz] = g.dims;
  const plane = ox * oy;
  const data = int16 ? new Int16Array(plane * oz) : new Float32Array(plane * oz);
  let min = Infinity;
  let max = -Infinity;
  const acc = xy === 1 && z === 1 ? null : new Float64Array(plane);
  for (let k = 0; k < oz; k += 1) {
    if (opts.signal?.aborted) throw new ReconCancelled();
    acc?.fill(0);
    for (let dz = 0; dz < z; dz += 1) {
      const src = await slices[order[k * z + dz]].values();
      if (src.length < nx * ny) throw new Error("A slice has fewer pixels than its size says.");
      if (!acc) {
        const base = k * plane;
        for (let p = 0; p < plane; p += 1) {
          let v = src[p];
          if (int16) v = v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v);
          data[base + p] = v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      } else {
        for (let y = 0; y < oy; y += 1) {
          for (let x = 0; x < ox; x += 1) {
            let sum = 0;
            for (let by = 0; by < xy; by += 1) {
              const row = (y * xy + by) * nx + x * xy;
              for (let bx = 0; bx < xy; bx += 1) sum += src[row + bx];
            }
            acc[y * ox + x] += sum;
          }
        }
      }
      opts.onProgress?.(k * z + dz + 1, oz * z);
    }
    if (acc) {
      const div = xy * xy * z;
      const base = k * plane;
      for (let p = 0; p < plane; p += 1) {
        const v = int16 ? Math.round(acc[p] / div) : acc[p] / div;
        data[base + p] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  return { geometry: g, data, reduced: [xy, z], bytes: data.byteLength, min, max };
}
