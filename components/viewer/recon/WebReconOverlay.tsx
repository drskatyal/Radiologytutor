"use client";

// Web: multi-oblique, slab and curved / cross-curved MPR over the viewer's
// stage. The volume is assembled from the series' slices through the same
// image loader the viewer uses (local files never leave the browser), held
// only while this is open, and sampled by the shared core.

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { buildWebReconSource, type WebImageAccess } from "@/lib/recon/webReconSource";
import { ReconWorkspace } from "./ReconWorkspace";
import type { ReconSource } from "./types";

const first = (v: unknown): number | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};

async function cornerstoneAccess(): Promise<WebImageAccess> {
  const core = await import("@cornerstonejs/core");
  return {
    plane: (id) => core.metaData.get("imagePlaneModule", id) as ReturnType<WebImageAccess["plane"]>,
    load: async (id) => {
      const img = (await core.imageLoader.loadAndCacheImage(id)) as unknown as {
        getPixelData: () => ArrayLike<number>;
        slope?: number;
        intercept?: number;
        preScale?: { scaled?: boolean };
      };
      // The loader may already have applied the rescale ("preScale").
      const scaled = !!img.preScale?.scaled;
      return { pixels: img.getPixelData(), slope: scaled ? 1 : img.slope ?? 1, intercept: scaled ? 0 : img.intercept ?? 0 };
    },
    window: (id) => {
      const voi = core.metaData.get("voiLutModule", id) as { windowWidth?: unknown; windowCenter?: unknown } | undefined;
      const w = first(voi?.windowWidth);
      const c = first(voi?.windowCenter);
      return w && w > 1 && c != null ? [w, c] : null;
    },
  };
}

export function WebReconOverlay({ imageIds, title, onExit }: { imageIds: readonly string[]; title: string; onExit: () => void }) {
  const [source, setSource] = useState<ReconSource | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setSource(null);
    setError(null);
    setProgress(0);
    void (async () => {
      try {
        const access = await cornerstoneAccess();
        const built = await buildWebReconSource(imageIds, access, {
          signal: ctl.signal,
          onProgress: (done, total) => setProgress(done / Math.max(1, total)),
        });
        if (!ctl.signal.aborted) setSource(built);
      } catch (e) {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ctl.abort();
  }, [imageIds]);

  return (
    <div
      // The reading room's dark surface and brand green (.modal-reading tokens).
      className="modal-reading absolute inset-0 z-30 flex flex-col bg-canvas text-primary"
      // The workspace owns its keys and pointer: the stack viewer underneath must not react.
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {source ? (
        <ReconWorkspace source={source} title={title} onExit={onExit} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-imaging p-6 text-center text-sm text-white/80">
          {error ? (
            <p role="alert" className="text-danger">
              The volume could not be built: {error}
            </p>
          ) : (
            <>
              <p className="tabular-nums">Building the volume in this browser… {Math.round(progress * 100)}%</p>
              <ProgressBar value={progress} label="Building the volume" className="w-56" />
            </>
          )}
          <Button size="sm" variant="secondary" onClick={onExit} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
            Back to images
          </Button>
        </div>
      )}
    </div>
  );
}
