"use client";

// Fills series-rail counts and middle-slice covers without touching the
// viewport's first-pixel path. Known instance lists (the prefetch manifest)
// are applied immediately as text. Rendered thumbnails, and any QIDO or
// metadata read for a series the manifest did not list, wait until the main
// image is up.

import { useEffect, useMemo, useState } from "react";
import {
  fetchSeriesRailStats,
  isBundledSeries,
  presentSeriesRail,
  railStatsBySeries,
  type RailEntry,
  type RailInstanceSource,
  type RailStats,
} from "@/lib/seriesRail";
import type { CaseSeries } from "@/lib/viewerSource";

export function useLazySeriesRail(
  series: readonly CaseSeries[],
  mainImageReady: boolean | undefined,
  listed?: readonly RailInstanceSource[] | null,
  loadStats: (series: CaseSeries) => Promise<RailStats> = fetchSeriesRailStats
): RailEntry[] {
  const known = useMemo(() => railStatsBySeries(listed), [listed]);
  const [fetched, setFetched] = useState<Record<string, RailStats>>({});
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());

  const missingKey = series
    .filter((item) => {
      if (isBundledSeries(item)) return false;
      if (known[item.seriesInstanceUID] || fetched[item.seriesInstanceUID]) return false;
      if (failed.has(item.seriesInstanceUID)) return false;
      return true;
    })
    .map((item) => item.seriesInstanceUID)
    .join("\0");

  useEffect(() => {
    // A one-series study does not render the rail. Don't spend a lookup on it.
    if (mainImageReady !== true || !missingKey || series.length < 2) return;
    const pending = series.filter((item) => missingKey.split("\0").includes(item.seriesInstanceUID));
    if (pending.length === 0) return;
    let cancelled = false;

    void (async () => {
      // One series at a time. The viewport may still be prefetching the open
      // stack; a parallel metadata burst would steal that connection.
      for (const item of pending) {
        if (cancelled) return;
        try {
          const stats = await loadStats(item);
          if (cancelled) return;
          setFetched((prev) => ({ ...prev, [item.seriesInstanceUID]: stats }));
          setFailed((prev) => {
            if (!prev.has(item.seriesInstanceUID)) return prev;
            const next = new Set(prev);
            next.delete(item.seriesInstanceUID);
            return next;
          });
        } catch {
          if (cancelled) return;
          setFailed((prev) => {
            const next = new Set(prev);
            next.add(item.seriesInstanceUID);
            return next;
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // missingKey already captures which series still need a lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainImageReady, missingKey, loadStats]);

  return presentSeriesRail({
    series,
    mainImageReady,
    known,
    fetched,
    failed,
  });
}
