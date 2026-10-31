"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Columns2, GraduationCap, Grid2x2, Link2, Rows2, Square } from "lucide-react";
import { Badge, Button, Skeleton, Tooltip, useToast } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { ImagingLayout } from "@/components/viewer/ImagingLayout";
import { useResolvedSeries } from "@/components/viewer/useResolvedSeries";
import { caseTeachHref } from "@/lib/caseShare";
import {
  hangSeries,
  layoutById,
  layoutsForSeriesCount,
  nextLayout,
  paneCount,
  type HangingLayoutId,
} from "@/lib/hangingLayout";
import { parseViewLink, viewLinkQuery, viewLinkUrl, type ViewLinkState } from "@/lib/viewLink";
import { caseSeriesToSource, type CaseSeries, type ViewerSource } from "@/lib/viewerSource";
import { ShareLinkControls } from "./ShareLinkControls";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-none bg-[#0b0b0b]" />,
});

const LAYOUT_ICONS: Record<HangingLayoutId, typeof Square> = {
  "1x1": Square,
  "1x2": Columns2,
  "2x1": Rows2,
  "2x2": Grid2x2,
};

/** Grid template per layout. Static strings so Tailwind keeps them. */
const GRID_CLASS: Record<HangingLayoutId, string> = {
  "1x1": "grid-cols-1 grid-rows-1",
  "1x2": "grid-cols-2 grid-rows-1 max-sm:grid-cols-1 max-sm:grid-rows-2",
  "2x1": "grid-cols-1 grid-rows-2",
  "2x2": "grid-cols-2 grid-rows-2",
};

/**
 * DICOM viewer without the attending: the standalone reading surface behind
 * the case library and share links. Scroll, window, measure, cine, MPR, a
 * series rail, hanging layouts, and a link that reopens the exact view.
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
  const { toast } = useToast();
  const params = useSearchParams();
  // The link is read once: later URL edits are ours (none) or the reader's.
  const [link] = useState<ViewLinkState>(() => (params ? parseViewLink(params) : {}));
  const [ready, setReady] = useState(false);
  const resolved = useResolvedSeries(caseId, series);
  const rail = resolved.series.length > 0 ? resolved.series : series;
  const showSampleNote = resolved.settled && !resolved.imagingLive;

  const linkedSeriesIndex = link.seriesInstanceUID
    ? Math.max(0, rail.findIndex((s) => s.seriesInstanceUID === link.seriesInstanceUID))
    : 0;
  const [layoutId, setLayoutId] = useState<HangingLayoutId>(link.layout ?? "1x1");
  const layout = layoutById(layoutId);
  const [panes, setPanes] = useState<number[]>(() =>
    hangSeries(layoutById(link.layout ?? "1x1"), Math.max(1, rail.length), [], linkedSeriesIndex)
  );
  const [activePane, setActivePane] = useState(0);
  const [barHost, setBarHost] = useState<HTMLDivElement | null>(null);
  const controlsRef = useRef<Array<MutableRefObject<CornerstoneControls | null>>>([]);
  for (let i = controlsRef.current.length; i < 4; i += 1) {
    controlsRef.current.push({ current: null });
  }

  // Re-hang when the layout or the rail length changes. Keeps what is hung.
  const railCount = rail.length;
  useEffect(() => {
    setPanes((prev) => {
      const next = hangSeries(layout, Math.max(1, railCount), prev, prev[0] ?? linkedSeriesIndex);
      return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
    });
    setActivePane((p) => Math.min(p, paneCount(layout) - 1));
  }, [layout, railCount, linkedSeriesIndex]);

  // The rail resolves after first paint; a linked series may only now exist.
  const linkedAppliedRef = useRef(false);
  useEffect(() => {
    if (linkedAppliedRef.current || !link.seriesInstanceUID) return;
    const at = rail.findIndex((s) => s.seriesInstanceUID === link.seriesInstanceUID);
    if (at < 0) return;
    linkedAppliedRef.current = true;
    setPanes((prev) => (prev[0] === at ? prev : [at, ...prev.slice(1)]));
  }, [rail, link.seriesInstanceUID]);

  const offered = layoutsForSeriesCount(rail.length);
  const activeSeriesIndex = Math.min(panes[activePane] ?? 0, Math.max(0, rail.length - 1));

  const cycleLayout = useCallback(() => {
    setLayoutId((current) => nextLayout(current, rail.length));
  }, [rail.length]);

  const selectSeries = useCallback(
    (index: number) => {
      setPanes((prev) => prev.map((value, i) => (i === activePane ? index : value)));
    },
    [activePane]
  );

  const viewState = useCallback((): ViewLinkState => {
    const controls = controlsRef.current[activePane]?.current;
    const start = controls?.ready ? controls.getStartState() : null;
    return {
      seriesInstanceUID: rail[activeSeriesIndex]?.seriesInstanceUID,
      image: start ? start.sliceIndex + 1 : undefined,
      ww: start?.ww,
      wc: start?.wc,
      layout: layoutId,
    };
  }, [activePane, activeSeriesIndex, layoutId, rail]);

  const copyViewLink = useCallback(async () => {
    const url = viewLinkUrl(
      window.location.origin,
      `${window.location.pathname}${window.location.search}`,
      viewState()
    );
    try {
      await navigator.clipboard.writeText(url);
      toast({
        variant: "success",
        title: "View link copied",
        description: sharedLink
          ? "Opens this shared study on the same image and window."
          : "Opens this case on the same image, window and layout.",
      });
    } catch {
      toast({ variant: "info", title: "Copy this link", description: url });
    }
  }, [sharedLink, toast, viewState]);

  const paneCountNow = paneCount(layout);
  const multi = paneCountNow > 1;

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas">
      <header className="z-30 flex shrink-0 items-center justify-between gap-2 border-b border-subtle bg-surface px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/library"
            className="inline-flex h-9 shrink-0 items-center rounded-lg px-2.5 text-sm font-medium text-secondary transition-colors duration-75 hover:bg-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-[0.97]"
          >
            Library
          </Link>
          <span aria-hidden="true" className="h-4 w-px bg-white/10" />
          <h1 className="truncate font-display text-base font-semibold text-primary">{title}</h1>
          {modality ? (
            <Badge variant="neutral" className="hidden sm:inline-flex">
              {modality}
            </Badge>
          ) : null}
          {sharedLink ? (
            <Badge variant="accent" className="shrink-0">
              Shared
            </Badge>
          ) : null}
          {showSampleNote && namedStudy ? (
            <span className="hidden truncate text-xs text-muted lg:inline">
              Offline sample shown until the archive returns this study.
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {offered.length > 1 ? (
            <div
              role="radiogroup"
              aria-label="Hanging layout"
              className="hidden items-center rounded-lg border border-subtle bg-canvas p-0.5 sm:inline-flex"
            >
              {offered.map((option) => {
                const Icon = LAYOUT_ICONS[option.id];
                const on = option.id === layoutId;
                return (
                  <Tooltip key={option.id} label={option.label} shortcut={["G"]} side="bottom">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={`${option.label} layout`}
                      onClick={() => setLayoutId(option.id)}
                      className={cn(
                        "inline-flex h-8 w-8 items-center justify-center rounded-md transition-[transform,background-color,color] duration-75 active:scale-[0.92]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                        on ? "bg-elevated text-primary shadow-sm" : "text-muted hover:text-primary"
                      )}
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          ) : null}
          <Tooltip label="Copy a link to this exact view" side="bottom">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copyViewLink()}
              disabled={!ready}
              leadingIcon={<Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              <span className="max-sm:sr-only">View link</span>
            </Button>
          </Tooltip>
          {showShare ? (
            <ShareLinkControls
              caseId={caseId}
              initialPath={sharePath}
              getViewQuery={() => viewLinkQuery(viewState())}
            />
          ) : null}
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
      </header>

      {/* "Imaging pane", not "DICOM viewer": the viewport inside carries that
          label, and two identically-named landmarks make a screen reader
          announce the same thing twice. */}
      <div className="relative min-h-0 flex-1 bg-imaging" role="region" aria-label="Imaging pane">
        <ImagingLayout
          fill
          series={rail}
          activeIndex={activeSeriesIndex}
          onSelectSeries={selectSeries}
          mainImageReady={ready}
          className="absolute inset-0"
        >
          <div className="flex h-full min-h-0 flex-col">
            <div
              className={cn(
                "grid min-h-0 flex-1",
                multi && "gap-px bg-[#1F1F1F]",
                GRID_CLASS[layout.id]
              )}
            >
              {panes.slice(0, paneCountNow).map((seriesIndex, pane) => {
                const paneSeries = rail[Math.min(seriesIndex, Math.max(0, rail.length - 1))];
                const paneSource = paneSeries ? caseSeriesToSource(paneSeries) : source;
                const isActive = pane === activePane;
                return (
                  <div key={pane} className="relative min-h-0 min-w-0 bg-imaging">
                    <CornerstoneViewer
                      source={paneSource}
                      series={rail}
                      activeSeriesIndex={Math.min(seriesIndex, Math.max(0, rail.length - 1))}
                      onSeriesChange={(uid) => {
                        const next = rail.findIndex((item) => item.seriesInstanceUID === uid);
                        if (next < 0) return;
                        setPanes((prev) => prev.map((v, i) => (i === pane ? next : v)));
                      }}
                      modality={modality}
                      chrome="edge"
                      toolbarHost={barHost}
                      active={isActive}
                      onActivate={() => setActivePane(pane)}
                      defaultTool="StackScroll"
                      questionMarkHelp
                      onCycleLayout={rail.length > 0 ? cycleLayout : undefined}
                      controls={controlsRef.current[pane]}
                      openSlice={
                        // Only while pane 0 still shows the linked series —
                        // a re-mount on another series must open mid-stack.
                        pane === 0 && link.image != null && seriesIndex === linkedSeriesIndex
                          ? { sliceIndex: link.image - 1 }
                          : null
                      }
                      initialWindow={
                        pane === 0 && link.ww != null && link.wc != null
                          ? { ww: link.ww, wc: link.wc }
                          : null
                      }
                      onReady={() => {
                        if (pane === 0) setReady(true);
                      }}
                      instanceId={pane === 0 ? `view-${caseId}` : `view-${caseId}-p${pane}`}
                      className="h-full w-full"
                    />
                    {multi ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "pointer-events-none absolute inset-0 z-20 transition-shadow duration-100",
                          isActive ? "shadow-[inset_0_0_0_1.5px_rgb(var(--accent))]" : ""
                        )}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
            {/* One toolbar for the whole grid; it acts on the outlined pane. */}
            <div ref={setBarHost} className="shrink-0" />
          </div>
        </ImagingLayout>
      </div>
    </div>
  );
}
