"use client";

// The record/replay imaging stage: the shared reading frame
// (components/viewer/ViewerFrame.tsx) over the case's archive series, with a
// teaching layer carrying the animated replay overlay, cursor capture and a
// floating REC/REPLAY HUD. Used by the /record demo and the author capture
// flow (RecordingStudio). The recorder keeps driving the viewer through its
// own handle (lib/teachingLayer bindControls) and hears every viewer event
// (onViewerEvent); a skeleton covers the image until it is ready.
//
// Two authoring modes share this stage:
//   1. Annotate — click the finding → popover (parent) for mic dictation.
//   2. Record walk-through — Alt+X / Record captures cursor + viewer events.
//
// Cursor capture: while recording we track normalized pointer position over the
// imaging surface so replay can retrace the teacher's laser pointer.

import { useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { Badge, Skeleton, Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { OpenSlice } from "@/lib/viewerLoad";
import { seriesForSource, type CaseSeries, type ViewerSource } from "@/lib/viewerSource";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { ReplayOverlay, type ReplayOverlayHandle } from "@/components/ReplayOverlay";
import { ViewerFrame, type FrameInitialView } from "@/components/viewer/ViewerFrame";
import type { TeachingLayer } from "@/lib/teachingLayer";
import type { ViewerEvent } from "@/lib/types";
import type { RecordPhase } from "./useRecordReplay";

export function RecordStage({
  source,
  series,
  activeSeriesIndex,
  onSeriesChange,
  seriesLoading,
  openSlice = null,
  modality,
  controls,
  overlay,
  ready,
  phase,
  elapsedMs,
  progress,
  onReady,
  onEvent,
  onCursor,
  onMarker,
  annotateMode = false,
  onAnnotateClick,
  annotateSlot,
  sketchLayer,
  sketchPalette,
}: {
  source: ViewerSource;
  /** Multi-series rail; when >1 entry a navigator renders beside the viewer. */
  series?: CaseSeries[];
  activeSeriesIndex?: number;
  /** Switch the viewer's series (by index) — also moves the navigator. */
  onSeriesChange?: (index: number) => void;
  /** Active-series change FROM the viewer (user/replay) → keep nav in sync. */
  seriesLoading?: boolean;
  /** Last teacher slice on the series the stage opens. */
  openSlice?: OpenSlice | null;
  modality?: string;
  controls: MutableRefObject<CornerstoneControls | null>;
  overlay: MutableRefObject<ReplayOverlayHandle | null>;
  ready: boolean;
  phase: RecordPhase;
  elapsedMs: number;
  progress: number;
  onReady: (c: CornerstoneControls) => void;
  onEvent: (e: ViewerEvent) => void;
  onCursor: (x: number, y: number) => void;
  onMarker?: (x: number, y: number) => void;
  /**
   * When true (and not recording/replaying), a transparent hit layer captures
   * clicks on the imaging square and reports normalized [0,1] coords.
   */
  annotateMode?: boolean;
  onAnnotateClick?: (x: number, y: number) => void;
  /** Rendered inside the imaging overlay (e.g. AnnotatePopover). */
  annotateSlot?: ReactNode;
  /** Teacher sketch ink + capture layer (Studio). Sits above the replay laser. */
  sketchLayer?: ReactNode;
  /** Floating sketch tool palette on the imaging surface (Studio). */
  sketchPalette?: ReactNode;
}) {
  const imageRef = useRef<HTMLDivElement>(null);
  const markerPress = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const clickToAnnotate =
    annotateMode && phase === "idle" && !!onAnnotateClick && ready;

  const normFromEvent = (e: React.PointerEvent | React.MouseEvent) => {
    const el = imageRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = markerPress.current;
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) press.moved = true;
    if (phase !== "recording" && phase !== "starting") return;
    const p = normFromEvent(e);
    if (p) onCursor(p.x, p.y);
  };

  const handleAnnotateClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const p = normFromEvent(e);
    if (!p) return;
    onAnnotateClick?.(p.x, p.y);
  };

  // The case's series, or the one stack a demo hands in (the bundled sample).
  const rail = useMemo(() => (series && series.length > 0 ? series : seriesForSource(source)), [series, source]);
  const frameSource = useMemo(() => ({ kind: "cloud" as const, series: rail }), [rail]);
  // Read once by the frame: the series and slice the stage opens on.
  const openSliceRef = useRef(openSlice);
  openSliceRef.current = openSlice;
  const firstUid = useRef(rail[Math.min(activeSeriesIndex ?? 0, Math.max(0, rail.length - 1))]?.seriesInstanceUID).current;
  const initial = useMemo<FrameInitialView>(
    () => ({ seriesInstanceUID: firstUid, openSlice: (uid) => (uid === firstUid ? openSliceRef.current : null) }),
    [firstUid]
  );
  // Callbacks through a ref: the layer object changes only with what it draws.
  const live = useRef({ onReady, onEvent, onSeriesChange, rail });
  live.current = { onReady, onEvent, onSeriesChange, rail };

  const imageOverlay = (
    <div ref={imageRef} className="pointer-events-none absolute inset-0">
      <ReplayOverlayMount overlay={overlay} active={phase === "replaying"} />
      {sketchLayer}
      {sketchPalette && (
        // Portaled menus/tooltips still bubble through the React
        // tree: keep the viewer from refocusing the image (which
        // closes the export menu) or reading menu arrow keys.
        <div
          className="absolute left-3 top-1/2 z-30 -translate-y-1/2"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {sketchPalette}
        </div>
      )}

      {clickToAnnotate && (
        <button
          type="button"
          aria-label="Click on the finding to annotate"
          className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair bg-transparent"
          onClick={handleAnnotateClick}
        />
      )}

      {annotateSlot}

      {clickToAnnotate && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-center">
          <span className="rounded-md bg-black/80 px-3 py-2 text-xs font-medium text-white shadow-lg ring-1 ring-white/25">
            Click the finding to place a marker and dictate
          </span>
        </div>
      )}

      {/* Below the fullscreen control, which sits on the stage corner. */}
      {phase === "recording" && (
        <div className="absolute right-3 top-14 z-30 flex animate-fade-up items-center gap-2 rounded-md bg-black/80 px-3 py-2 text-white shadow-lg ring-1 ring-white/20">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
          </span>
          <span className="text-sm font-semibold uppercase tracking-wide text-danger">Rec</span>
          <span className="text-sm tabular-nums text-white">{formatMs(elapsedMs)}</span>
        </div>
      )}

      {phase === "replaying" && (
        <div className="absolute inset-x-3 bottom-3 z-30 flex animate-fade-up flex-col gap-1.5 rounded-md bg-black/80 px-3 py-2 shadow-lg ring-1 ring-white/20">
          <div className="flex items-center gap-2">
            <Badge variant="accent" dot>
              Replaying
            </Badge>
            <span className="text-xs tabular-nums text-white">{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/25">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-100 ease-linear"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {!ready && <StageSkeleton label="Warming images…" />}
    </div>
  );

  const teaching = useMemo<TeachingLayer>(
    () => ({
      // The author's first move is usually the window, not the stack.
      defaultTool: "WindowLevel",
      bindControls: (pane) => (pane === 0 ? controls : null),
      overlay: (pane) => (pane.index === 0 ? imageOverlay : null),
      onViewer: (_viewer, pane) => {
        if (pane.index === 0 && controls.current) live.current.onReady(controls.current);
      },
      // The record stream: every event of the recorded pane.
      onViewerEvent: (pane, event) => {
        if (pane.index === 0) live.current.onEvent(event);
      },
      onSeriesChange: (uid) => {
        const index = live.current.rail.findIndex((item) => item.seriesInstanceUID === uid);
        if (index >= 0) live.current.onSeriesChange?.(index);
      },
    }),
    [controls, imageOverlay]
  );
  // The frame shows its own series panel; there is no separate loading rail.
  void seriesLoading;
  void modality;

  return (
    <div className="viewer-shell relative min-w-0" onPointerMove={handleMove}
      onPointerDownCapture={e => { markerPress.current = e.button === 0 ? { x: e.clientX, y: e.clientY, moved: false } : null; }}
      onPointerCancel={() => { markerPress.current = null; }}
      onClick={e => {
      const press = markerPress.current; markerPress.current = null;
      if (!press || press.moved || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
      if ((phase !== "recording" && phase !== "starting") || (e.target as HTMLElement).closest("button")) return;
      const point = normFromEvent(e); if (point) onMarker?.(point.x, point.y);
    }}>
      <ViewerFrame tone="page" source={frameSource} teaching={teaching} initial={initial} />
    </div>
  );
}

function ReplayOverlayMount({
  overlay,
  active,
}: {
  overlay: MutableRefObject<ReplayOverlayHandle | null>;
  active: boolean;
}) {
  return (
    <ReplayOverlay
      ref={(h) => {
        overlay.current = h;
      }}
      active={active}
    />
  );
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function StageSkeleton({ label }: { label: string }) {
  return (
    <div className={cn("absolute inset-0 flex items-center justify-center bg-imaging")}>
      <Skeleton className="absolute inset-0 rounded-none bg-elevated/30" />
      <div className="relative flex items-center gap-2 text-sm text-white">
        <Spinner size="sm" label={label} />
        {label}
      </div>
    </div>
  );
}
