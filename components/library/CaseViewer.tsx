"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { Badge, Button, Skeleton } from "@/components/ui";
import { ImagingLayout } from "@/components/viewer/ImagingLayout";
import { useResolvedSeries } from "@/components/viewer/useResolvedSeries";
import { caseTeachHref } from "@/lib/caseShare";
import { caseSeriesToSource, type CaseSeries, type ViewerSource } from "@/lib/viewerSource";
import { ShareLinkControls } from "./ShareLinkControls";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

/**
 * DICOM viewer without the attending. Scroll, window, zoom, series rail.
 * Teach is a separate link, and only when this open is not a share URL.
 */
export function CaseViewer({
  caseId,
  title,
  modality,
  source,
  series,
  showTeach,
  showShare,
  sharePath,
  sharedLink,
  namedStudy = false,
}: {
  caseId: string;
  title: string;
  modality: string;
  source: ViewerSource;
  series: CaseSeries[];
  showTeach: boolean;
  showShare: boolean;
  sharePath: string | null;
  sharedLink: boolean;
  /** Case names a DICOM study. The offline sample is only a stand-in when that study cannot be listed. */
  namedStudy?: boolean;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const resolved = useResolvedSeries(caseId, series);
  const rail = resolved.series.length > 0 ? resolved.series : series;
  const index = rail.length === 0 ? 0 : Math.min(activeIndex, rail.length - 1);
  const active = rail[index];
  const liveSource = useMemo(
    () => (active ? caseSeriesToSource(active) : source),
    [active, source]
  );
  const showSampleNote = resolved.settled && !resolved.imagingLive;

  const onSeriesChange = useCallback(
    (uid: string) => {
      const next = rail.findIndex((item) => item.seriesInstanceUID === uid);
      if (next >= 0) setActiveIndex(next);
    },
    [rail]
  );

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas">
      <header className="z-30 flex shrink-0 flex-col border-b border-subtle bg-surface">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href="/library"
              className="inline-flex h-9 shrink-0 items-center rounded-lg px-2.5 text-sm font-medium text-secondary hover:bg-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              Library
            </Link>
            <h1 className="truncate font-display text-base font-semibold text-primary">{title}</h1>
            <Badge variant="neutral" className="hidden sm:inline-flex">
              {modality}
            </Badge>
            <Badge variant="accent" className="shrink-0">
              {sharedLink ? "Shared" : "Viewer"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {showShare ? <ShareLinkControls caseId={caseId} initialPath={sharePath} /> : null}
            {showTeach ? (
              <Link href={caseTeachHref(caseId)}>
                <Button
                  size="sm"
                  leadingIcon={<GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                  Teach
                </Button>
              </Link>
            ) : null}
          </div>
        </div>
        <p className="px-3 pb-2 text-xs text-muted">
          {sharedLink ? "Shared study. Scroll, window, and zoom." : "Viewer. Scroll, window, and zoom."}
          {showSampleNote && namedStudy
            ? " Showing the offline sample until the archive returns this study."
            : ""}
        </p>
      </header>

      <div className="relative min-h-0 flex-1 bg-imaging" role="region" aria-label="DICOM viewer">
        <ImagingLayout
          fill
          series={rail}
          activeIndex={index}
          onSelectSeries={setActiveIndex}
          mainImageReady={ready}
          className="absolute inset-0"
        >
          <CornerstoneViewer
            source={liveSource}
            series={rail}
            activeSeriesIndex={index}
            onSeriesChange={onSeriesChange}
            modality={modality}
            chrome="edge"
            onReady={() => setReady(true)}
            instanceId={`view-${caseId}`}
            className="h-full w-full"
          />
        </ImagingLayout>
      </div>
    </div>
  );
}
