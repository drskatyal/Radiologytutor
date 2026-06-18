"use client";

// Client-side cache warming for the student session (CLAUDE.md §4a). The case
// open already knows exactly which series + instances the walk-through needs
// (the server-built PrefetchManifest), so we issue idle/low-priority GETs to
// the same-origin /api/dicomweb proxy to warm the HTTP cache. This is purely
// opportunistic — failures are swallowed and never block the viewer.

import type { PrefetchManifest } from "@/lib/prefetch";

const WADO_ROOT = "/api/dicomweb";
/** Cap warmed slices per series so we don't hammer the proxy on huge studies. */
const MAX_INSTANCES_PER_SERIES = 24;

let warmed = false;

function whenIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (ric) ric(fn);
  else setTimeout(fn, 200);
}

/**
 * Warm the DICOMweb cache for a case's findings. Series are warmed in the order
 * findings need them; within a series, instances in display order (bounded).
 * Idempotent per page load.
 */
export function warmPrefetch(manifest: PrefetchManifest): void {
  if (warmed || !manifest.hasImaging) return;
  warmed = true;

  whenIdle(() => {
    for (const series of manifest.series) {
      const { studyInstanceUID, seriesInstanceUID, instances } = series;
      if (!studyInstanceUID || !seriesInstanceUID) continue;

      for (const inst of instances.slice(0, MAX_INSTANCES_PER_SERIES)) {
        const url =
          `${WADO_ROOT}/studies/${studyInstanceUID}` +
          `/series/${seriesInstanceUID}/instances/${inst.sopInstanceUID}/frames/1`;
        // Low-priority, best-effort. Browsers dedupe these with the loader's
        // later request, so the slice is already in cache when shown.
        fetch(url, {
          priority: "low",
          cache: "force-cache",
          headers: { Accept: "multipart/related; type=application/octet-stream" },
        } as RequestInit & { priority: "low" }).catch(() => {
          /* opportunistic — ignore */
        });
      }
    }
  });
}
