"use client";

// A stored study in the same Cornerstone viewer as the free viewer, read over
// DICOMweb through our proxy: `/api/dicomweb` for the owner, or
// `/api/dicomweb/s/<token>` for a share link or embed. Saved markup (arrows,
// measurements) is placed back on its slices when a series opens; the owner
// can draw more and save it.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layers } from "lucide-react";
import { Spinner, cn } from "@/components/ui";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { CaseSeries } from "@/lib/viewerSource";
import type { RecordedAnnotation, ViewerEvent } from "@/lib/types";
import type { MarkupItem, StudySeriesSummary } from "@/lib/cloud/types";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-imaging text-white/70" role="status">
      <Spinner size="md" label="Loading the viewer" />
    </div>
  ),
});

export interface RemoteStudyViewerProps {
  wadoRsRoot: string;
  studyInstanceUID: string;
  series: StudySeriesSummary[];
  /** Saved markup to show (omit for an unknown). */
  markup?: MarkupItem[];
  /** Owner only: receives every new stroke drawn, tagged with its series. */
  onStroke?: (item: MarkupItem) => void;
  className?: string;
}

export function RemoteStudyViewer({ wadoRsRoot, studyInstanceUID, series, markup, onStroke, className }: RemoteStudyViewerProps) {
  const caseSeries: CaseSeries[] = useMemo(
    () =>
      series.map((s) => ({
        seriesInstanceUID: s.seriesInstanceUID,
        studyInstanceUID,
        modality: s.modality,
        description: s.description,
        seriesNumber: s.seriesNumber,
        instanceCount: s.instanceCount,
        wadoRsRoot,
      })),
    [series, studyInstanceUID, wadoRsRoot]
  );
  // Open on the first series that has markup, else the first.
  const [active, setActive] = useState(() => {
    const i = markup?.length ? caseSeries.findIndex((s) => s.seriesInstanceUID === markup[0]!.seriesInstanceUID) : -1;
    return i >= 0 ? i : 0;
  });
  const controls = useRef<CornerstoneControls | null>(null);
  const applied = useRef(new Set<string>());
  const activeUid = caseSeries[active]?.seriesInstanceUID;

  const placeMarkup = useCallback(
    (c: CornerstoneControls) => {
      if (!activeUid || !markup?.length || applied.current.has(activeUid)) return;
      applied.current.add(activeUid);
      const items = markup.filter((m) => m.seriesInstanceUID === activeUid).sort((a, b) => (a.annotation.sliceIndex ?? 0) - (b.annotation.sliceIndex ?? 0));
      if (!items.length) return;
      for (const m of items) {
        if (m.annotation.sliceIndex != null) c.applyEvent({ t: 0, type: "slice", index: m.annotation.sliceIndex });
        c.applyEvent({ t: 0, type: "annotation", ...m.annotation });
      }
      // Land on the first marked slice: that is where the teaching point is.
      const first = items[0]!.annotation.sliceIndex;
      if (first != null) c.applyEvent({ t: 0, type: "slice", index: first });
    },
    [activeUid, markup]
  );

  // A series switch re-mounts annotations in the viewer: allow placing again.
  useEffect(() => {
    if (activeUid) applied.current.delete(activeUid);
  }, [activeUid]);

  const onEvent = useCallback(
    (e: ViewerEvent) => {
      if (e.type !== "annotation" || !onStroke || !activeUid) return;
      const { type: _type, ...annotation } = e;
      onStroke({ seriesInstanceUID: activeUid, annotation: annotation as RecordedAnnotation });
    },
    [activeUid, onStroke]
  );

  if (!caseSeries.length) {
    return (
      <div className={cn("flex items-center justify-center rounded-xl bg-imaging p-8 text-sm text-white/70", className)}>
        This study has no stored series.
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl bg-imaging md:flex-row", className)} data-testid="remote-viewer">
      {caseSeries.length > 1 && (
        <nav aria-label="Series" className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 p-2 md:w-56 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
          {caseSeries.map((s, i) => (
            <button
              key={s.seriesInstanceUID}
              type="button"
              onClick={() => setActive(i)}
              aria-current={i === active ? "true" : undefined}
              className={cn(
                "flex min-w-[10rem] items-start gap-2 rounded-lg px-3 py-2 text-left text-xs text-white/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 md:min-w-0",
                i === active ? "bg-white/15 text-white ring-1 ring-accent" : "hover:bg-white/10"
              )}
            >
              <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate font-semibold">
                  {s.modality ?? ""} {s.description ?? `Series ${s.seriesNumber ?? i + 1}`}
                </span>
                <span className="tabular-nums text-white/55">{s.instanceCount ?? "?"} images</span>
              </span>
            </button>
          ))}
        </nav>
      )}
      <div className="relative min-h-[320px] min-w-0 flex-1">
        <CornerstoneViewer
          series={caseSeries}
          activeSeriesIndex={active}
          onSeriesChange={(uid) => {
            const i = caseSeries.findIndex((s) => s.seriesInstanceUID === uid);
            if (i >= 0 && i !== active) setActive(i);
          }}
          onSeriesStep={(delta) => setActive((i) => (i + delta + caseSeries.length) % caseSeries.length)}
          controls={controls}
          chrome="edge"
          modality={caseSeries[active]?.modality}
          onReady={placeMarkup}
          onEvent={onEvent}
          questionMarkHelp
          className="h-full"
        />
      </div>
    </div>
  );
}
