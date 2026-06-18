"use client";

// The record/replay imaging stage: our Cornerstone viewer + the animated replay
// overlay + cursor capture, with a floating REC/REPLAY HUD. Used by the /record
// demo and the author capture flow. The viewer is dynamically imported
// (ssr:false — WebGL/DOM/workers); a skeleton covers it until ready.
//
// Cursor capture: while recording we track normalized pointer position over the
// imaging surface so replay can retrace the teacher's laser pointer.

import dynamic from "next/dynamic";
import { useRef, type MutableRefObject } from "react";
import { Badge, Skeleton, Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { ViewerSource } from "@/lib/viewerSource";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { ReplayOverlay, type ReplayOverlayHandle } from "@/components/ReplayOverlay";
import type { ViewerEvent } from "@/lib/types";
import type { RecordPhase } from "./useRecordReplay";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => <StageSkeleton label="Loading viewer…" />,
});

export function RecordStage({
  source,
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
}: {
  source: ViewerSource;
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
}) {
  const stageRef = useRef<HTMLDivElement>(null);

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phase !== "recording") return;
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The imaging surface is the top square of the stage (side = width).
    const side = r.width;
    const x = (e.clientX - r.left) / side;
    const y = (e.clientY - r.top) / side;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) onCursor(x, y);
  };

  return (
    <div ref={stageRef} className="relative w-full" onPointerMove={handleMove}>
      <CornerstoneViewer
        source={source}
        modality={modality}
        controls={controls}
        onReady={onReady}
        onEvent={onEvent}
        showToolbar
        className="w-full"
      />

      {/* Square overlay surface aligned to the imaging area: replay overlay
          (laser pointer + annotation draw-in) and the REC/REPLAY HUDs. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 aspect-square w-full">
        <ReplayOverlayMount overlay={overlay} active={phase === "replaying"} />

        {/* REC HUD — top-right so it clears the toolbar. */}
        {phase === "recording" && (
          <div className="absolute right-3 top-3 z-30 flex animate-fade-up items-center gap-2 rounded-full border border-danger/40 bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wide text-danger">Rec</span>
            <span className="text-xs tabular-nums text-secondary">{formatMs(elapsedMs)}</span>
          </div>
        )}

        {/* REPLAY HUD + progress. */}
        {phase === "replaying" && (
          <div className="absolute inset-x-3 bottom-3 z-30 flex animate-fade-up flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Badge variant="accent" dot>
                Replaying
              </Badge>
              <span className="text-xs tabular-nums text-secondary">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-elevated/80">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-100 ease-linear"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {!ready && (
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-square w-full">
          <StageSkeleton label="Warming images…" />
        </div>
      )}
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
      <div className="relative flex items-center gap-2.5 text-sm text-secondary">
        <Spinner size="sm" label={label} />
        {label}
      </div>
    </div>
  );
}
