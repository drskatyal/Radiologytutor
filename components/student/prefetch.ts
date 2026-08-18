"use client";

// Client-side cache warming for the student session (CLAUDE.md §4a).
//
// Finding-first, parallel, ≤30s interactive:
//   The server-built PrefetchManifest lists series in finding order. We warm
//   series[0] (the first finding) immediately with more slices, then remaining
//   series in Promise.allSettled batches of 3 so a prior+current CTA is not a
//   serial waterfall. Failures are swallowed; the viewer still loads on demand.
//
// Requests are same-origin /api/dicomweb (and later R2-backed frames). Never
// block playback on this work.

import type { PrefetchManifest, PrefetchSeries } from "@/lib/prefetch";

const WADO_ROOT = "/api/dicomweb";
/** Opening series: enough slices to start scrolling while others warm. */
const FIRST_SERIES_SLICES = 32;
/** Other series: keep the proxy / Orthanc off the critical path. */
const OTHER_SERIES_SLICES = 16;
/** Parallel series at a time (matches CasesPrefetcher batch size). */
const SERIES_BATCH = 3;

const warmed = new Set<string>();

function whenIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (ric) ric(fn);
  else setTimeout(fn, 200);
}

function frameUrl(series: PrefetchSeries, sopInstanceUID: string): string {
  return (
    `${WADO_ROOT}/studies/${series.studyInstanceUID}` +
    `/series/${series.seriesInstanceUID}/instances/${sopInstanceUID}/frames/1`
  );
}

function warmFrame(url: string): Promise<unknown> {
  return fetch(url, {
    priority: "low",
    cache: "force-cache",
    headers: { Accept: "application/octet-stream" },
  } as RequestInit & { priority: "low" }).catch(() => null);
}

async function warmSeries(series: PrefetchSeries, maxSlices: number): Promise<void> {
  const { studyInstanceUID, seriesInstanceUID, instances } = series;
  if (!studyInstanceUID || !seriesInstanceUID) return;
  await Promise.allSettled(
    instances.slice(0, maxSlices).map((inst) => warmFrame(frameUrl(series, inst.sopInstanceUID)))
  );
}

/**
 * Warm the DICOMweb cache for a case's findings. Finding series first, then
 * remaining series in parallel batches. Idempotent per page load.
 */
export function warmPrefetch(manifest: PrefetchManifest): void {
  if (warmed.has(manifest.caseId) || !manifest.hasImaging) return;
  warmed.add(manifest.caseId);

  whenIdle(() => {
    void (async () => {
      const list = manifest.series;
      const first = list[0];
      if (first) await warmSeries(first, FIRST_SERIES_SLICES);

      const rest = list.slice(1);
      for (let i = 0; i < rest.length; i += SERIES_BATCH) {
        const batch = rest.slice(i, i + SERIES_BATCH);
        await Promise.allSettled(batch.map((s) => warmSeries(s, OTHER_SERIES_SLICES)));
      }
    })();
  });
}
