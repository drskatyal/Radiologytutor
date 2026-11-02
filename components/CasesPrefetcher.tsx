"use client";

// Case-list warmer. Renders nothing.
//
// It used to issue one `/api/cases/{id}/prefetch` request per listed case on
// idle. That route's manifest is deliberately instance-free — enumerating
// every slice of every series was the multi-series open bottleneck, so
// `buildPrefetchManifest` returns series order with `hasImaging: false` and
// empty `instances` (see lib/prefetch.ts). Nothing on the list page read the
// response. N requests for a payload nobody consumed.
//
// What a case list can usefully warm is the part of opening a case that does
// not depend on which case: the Cornerstone engine chunks, ~3.8 MB raw /
// ~1.0 MB gzipped, code-split out of the page because the viewer is
// `next/dynamic({ssr:false})`. Warming them on idle means the click into a
// case skips that download and parse entirely.
//
// Per-case pixel warming belongs to the case page, where the series is known:
// `components/viewer/ViewerPrewarm.tsx`.

import { useEffect } from "react";
import { warmViewerModules } from "@/lib/viewerWarmup";

export default function CasesPrefetcher({ caseIds }: { caseIds: string[] }) {
  const hasCases = caseIds.length > 0;
  useEffect(() => {
    if (!hasCases) return;
    void warmViewerModules();
  }, [hasCases]);

  return null;
}
