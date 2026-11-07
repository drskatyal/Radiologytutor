// Web reconstruction source: a volume assembled in the browser from the
// slices the viewer's image loader decodes (local files stay local: nothing
// is uploaded), sampled by the shared core (packages/viewer-core/src/recon).
// The volume is the same reduction ladder as the desktop's, within a memory
// budget, and is dropped when the workspace closes.

import {
  buildReconVolume,
  sampleGrid,
  type BuiltVolume,
  type SliceSource,
} from "@flowrad/viewer-core/recon";
import type { ReconSource } from "@/components/viewer/recon/types";

/** The few Cornerstone calls this needs (kept narrow so it is testable). */
export interface WebImageAccess {
  plane: (imageId: string) =>
    | {
        imagePositionPatient?: number[] | null;
        rowCosines?: number[] | null;
        columnCosines?: number[] | null;
        rowPixelSpacing?: number | null;
        columnPixelSpacing?: number | null;
        rows?: number;
        columns?: number;
      }
    | null
    | undefined;
  /** Decoded stored values with the rescale to apply. */
  load: (imageId: string) => Promise<{ pixels: ArrayLike<number>; slope: number; intercept: number }>;
  /** The image's own window [width, centre], if any. */
  window?: (imageId: string) => [number, number] | null;
}

/** Default budget for the assembled volume (reduced resolution beyond it). */
export const WEB_RECON_BUDGET_BYTES = 384 * 1024 * 1024;

export function slicesFrom(imageIds: readonly string[], access: WebImageAccess): SliceSource[] {
  return imageIds.map((id) => {
    const p = access.plane(id);
    if (!p?.imagePositionPatient || !p.rowCosines || !p.columnCosines || !p.rows || !p.columns) {
      throw new Error("These images have no patient position or orientation, so they cannot be reconstructed.");
    }
    return {
      position: p.imagePositionPatient,
      orientation: [...p.rowCosines, ...p.columnCosines],
      pixelSpacing: [p.rowPixelSpacing || 1, p.columnPixelSpacing || 1],
      rows: p.rows,
      columns: p.columns,
      values: async () => {
        const { pixels, slope, intercept } = await access.load(id);
        if (slope === 1 && intercept === 0) return pixels;
        const out = new Float32Array(pixels.length);
        for (let i = 0; i < out.length; i += 1) out[i] = pixels[i] * slope + intercept;
        return out;
      },
    };
  });
}

export async function buildWebReconSource(
  imageIds: readonly string[],
  access: WebImageAccess,
  opts: { budgetBytes?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; saveImage?: ReconSource["saveImage"] } = {}
): Promise<ReconSource & { volume: BuiltVolume }> {
  const volume = await buildReconVolume(slicesFrom(imageIds, access), {
    budgetBytes: opts.budgetBytes ?? WEB_RECON_BUDGET_BYTES,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
  const mid = imageIds[Math.floor(imageIds.length / 2)];
  const own = mid ? access.window?.(mid) : null;
  const [xy, z] = volume.reduced;
  return {
    volume,
    geometry: volume.geometry,
    defaultWindow: own ?? [Math.max(1, volume.max - volume.min), (volume.max + volume.min) / 2],
    note: xy > 1 || z > 1 ? `Reduced resolution to fit memory (${[xy > 1 ? `${xy}× in-plane` : null, z > 1 ? `${z} slices averaged` : null].filter(Boolean).join(", ")})` : null,
    sample: (grid, _channel, signal) => sampleGrid(volume, grid, { signal }),
    saveImage: opts.saveImage,
  };
}
