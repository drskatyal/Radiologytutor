// The one thing a platform supplies to the reconstruction workspace: a
// volume's geometry and a way to sample it. The web samples a volume it
// assembled from decoded slices (lib/recon/webReconSource.ts); the desktop
// asks the Rust shell, which holds the volume natively
// (desktop/src/viewer/nativeReconSource.ts). Same grids, same contract.

import type { ReconImage, SampleGrid, VolumeGeometry } from "@flowrad/viewer-core/recon";

export interface ReconSource {
  geometry: VolumeGeometry;
  /**
   * Values on `grid`. `channel` names the pane: a newer request on the same
   * channel supersedes an older one (which rejects; the workspace ignores it).
   */
  sample: (grid: SampleGrid, channel: string, signal: AbortSignal) => Promise<ReconImage>;
  /** Initial window [width, centre]. */
  defaultWindow: [number, number];
  /** Shown once in the toolbar, e.g. a reduced-resolution note. */
  note?: string | null;
  modality?: string;
  /** Write a PNG the reader asked to export; omitted = browser download. */
  saveImage?: (bytes: Uint8Array, suggestedName: string) => Promise<string | null>;
}
