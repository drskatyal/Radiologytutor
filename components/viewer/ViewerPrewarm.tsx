"use client";

// Starts the viewer's unavoidable work before the viewer exists.
//
// Renders nothing. Mount it on any page that is about to show, or might soon
// show, a DICOM viewer:
//
//   • A **case page** — pass `series`. The engine chunks start downloading and,
//     in parallel, the opening frame's metadata + pixels land in the HTTP
//     cache. Time to first pixel becomes max(chunk download, 3 round trips)
//     instead of their sum.
//   • A **catalog / library list** — omit `series`. Only the engine chunks are
//     warmed, on an idle callback, so clicking into a case skips ~1 MB gzip of
//     download and parse.
//
// Everything is best-effort and idempotent per page load; see
// `lib/viewerWarmup.ts` for why the frame warm works through the HTTP cache
// rather than through Cornerstone's own cache.

import { useEffect } from "react";
import { warmOpeningFrame, warmViewerModules } from "@/lib/viewerWarmup";
import type { CaseSeries } from "@/lib/viewerSource";
import type { OpenSlice } from "@/lib/viewerLoad";

export function ViewerPrewarm({
  series,
  openSlice,
}: {
  /** The series the viewer will open. Omit on a list page. */
  series?: CaseSeries | null;
  /** The slice it will open on, when the case stored a teacher landing. */
  openSlice?: OpenSlice | null;
}) {
  const seriesInstanceUID = series?.seriesInstanceUID;
  const studyInstanceUID = series?.studyInstanceUID;
  const wadoRsRoot = series?.wadoRsRoot;
  const instanceCount = series?.instanceCount;
  const sopInstanceUID = openSlice?.sopInstanceUID;
  const sliceIndex = openSlice?.sliceIndex;

  useEffect(() => {
    void warmViewerModules();
  }, []);

  useEffect(() => {
    if (!seriesInstanceUID || !studyInstanceUID || !wadoRsRoot) return;
    const controller = new AbortController();
    void warmOpeningFrame(
      {
        wadoRsRoot,
        studyInstanceUID,
        seriesInstanceUID,
        ...(sopInstanceUID ? { sopInstanceUID } : {}),
        ...(sliceIndex != null ? { sliceIndex } : {}),
        ...(instanceCount != null ? { instanceCount } : {}),
      },
      { signal: controller.signal }
    );
    return () => controller.abort();
  }, [
    wadoRsRoot,
    studyInstanceUID,
    seriesInstanceUID,
    instanceCount,
    sopInstanceUID,
    sliceIndex,
  ]);

  return null;
}

export default ViewerPrewarm;
