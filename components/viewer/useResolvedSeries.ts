"use client";

// The case page renders from UIDs already stored on the case. This hook fills
// in DICOMweb descriptions and positive instance counts afterwards, without
// moving the series that is already open. The bundled sample is only used
// when the case has no series UIDs and the archive list is empty.

import { useEffect, useRef, useState } from "react";
import { mergeSeriesRail } from "@/lib/viewerLoad";
import {
  BUNDLED_CASE_SERIES,
  BUNDLED_STUDY_UID,
  type CaseSeries,
} from "@/lib/viewerSource";

export function useResolvedSeries(caseId: string, hints: readonly CaseSeries[]) {
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  const [series, setSeries] = useState<CaseSeries[]>(() => [...hints]);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setSettled(false);
    setSeries([...hintsRef.current]);
    void (async () => {
      try {
        const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/series`, {
          signal: ctrl.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!alive) return;
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { series?: CaseSeries[] };
        if (!alive) return;
        const incoming = Array.isArray(body.series) ? body.series : [];
        const merged = mergeSeriesRail(hintsRef.current, incoming);
        if (merged.length > 0) setSeries(merged);
        else if (hintsRef.current.length === 0) setSeries(BUNDLED_CASE_SERIES);
      } catch {
        if (!alive || ctrl.signal.aborted) return;
        if (hintsRef.current.length === 0) setSeries(BUNDLED_CASE_SERIES);
      } finally {
        if (alive && !ctrl.signal.aborted) setSettled(true);
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [caseId]);

  const imagingLive = series.some((item) => item.studyInstanceUID !== BUNDLED_STUDY_UID);
  return { series, loading: !settled, settled, imagingLive };
}
