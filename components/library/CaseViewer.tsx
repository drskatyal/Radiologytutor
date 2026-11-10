"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { GraduationCap, Link2 } from "lucide-react";
import { Badge, Button, Tooltip, useToast } from "@/components/ui";
import { ViewerFrame, type FrameInitialView, type FrameState } from "@/components/viewer/ViewerFrame";
import { useResolvedSeries } from "@/components/viewer/useResolvedSeries";
import { caseTeachHref } from "@/lib/caseShare";
import type { TeachingLayer, TeachingViewer } from "@/lib/teachingLayer";
import { parseViewLink, viewLinkQuery, viewLinkUrl, type ViewLinkState } from "@/lib/viewLink";
import type { CaseSeries, ViewerSource } from "@/lib/viewerSource";
import type { OpenSlice } from "@/lib/viewerLoad";
import { ShareLinkControls } from "./ShareLinkControls";

/** The layouts a view link can carry (lib/viewLink). */
const LINKABLE_LAYOUTS = new Set(["1x1", "1x2", "2x1", "2x2"]);

/**
 * DICOM viewer without the attending: the standalone reading surface behind
 * the case library and share links. The shared reading frame
 * (components/viewer/ViewerFrame.tsx) over the case's archive series — the
 * same series panel, hanging layouts, panes and toolbar as the FlowRad free
 * viewer — with RadLearn's teaching tool set (a teaching layer with no
 * overlay yet), and a link that reopens the exact view. Teach is a separate
 * link, and only when this open is not a share URL.
 */
export function CaseViewer({
  caseId,
  title,
  modality,
  series,
  showTeach,
  showShare,
  sharePath,
  sharedLink,
  namedStudy = false,
  openSlice = null,
}: {
  /**
   * The teacher's landing on series 0. The page prewarm (ViewerPrewarm) warms
   * exactly this slice, so the viewer must open on it too — opening mid-stack
   * instead threw the warm away and cost three extra archive round trips.
   */
  openSlice?: OpenSlice | null;
  caseId: string;
  title: string;
  modality: string;
  /** Kept for the page's prewarm contract; the frame builds each pane's source from `series`. */
  source?: ViewerSource;
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

  // Where the case opens: the link's series / image / window / layout, else
  // the teacher's warmed landing on the first series.
  const firstUid = series[0]?.seriesInstanceUID ?? null;
  const [initial] = useState<FrameInitialView>(() => ({
    seriesInstanceUID: link.seriesInstanceUID,
    layout: link.layout,
    openSlice: (uid) => {
      if (link.image != null && uid === (link.seriesInstanceUID ?? firstUid)) return { sliceIndex: link.image - 1 };
      return uid === firstUid ? openSlice : null;
    },
    window: (uid) =>
      link.ww != null && link.wc != null && uid === (link.seriesInstanceUID ?? firstUid) ? { ww: link.ww, wc: link.wc } : null,
  }));

  // Per-pane viewers and the frame's layout / focus, for the view link.
  const viewers = useRef(new Map<number, TeachingViewer>());
  const frame = useRef<FrameState>({ layout: link.layout ?? "1x1", activePane: 0, seriesInstanceUID: link.seriesInstanceUID ?? firstUid });
  const onFrameState = useCallback((state: FrameState) => {
    frame.current = state;
  }, []);
  const teaching = useMemo<TeachingLayer>(
    () => ({
      onViewer: (viewer, pane) => {
        viewers.current.set(pane.index, viewer);
        if (pane.index === 0) setReady(true);
      },
    }),
    []
  );

  const viewState = useCallback((): ViewLinkState => {
    const { layout, activePane, seriesInstanceUID } = frame.current;
    const view = viewers.current.get(activePane)?.view() ?? null;
    return {
      seriesInstanceUID: view?.seriesInstanceUID ?? seriesInstanceUID ?? undefined,
      image: view ? view.sliceIndex + 1 : undefined,
      ww: view?.windowWidth,
      wc: view?.windowCenter,
      layout: LINKABLE_LAYOUTS.has(layout) ? (layout as ViewLinkState["layout"]) : undefined,
    };
  }, []);

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

  const frameSource = useMemo(() => ({ kind: "cloud" as const, series: rail, label: title }), [rail, title]);

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
      <div className="viewer-shell relative flex min-h-0 flex-1 flex-col bg-imaging" role="region" aria-label="Imaging pane">
        <ViewerFrame
          tone="reading"
          source={frameSource}
          teaching={teaching}
          initial={initial}
          onFrameState={onFrameState}
        />
      </div>
    </div>
  );
}
