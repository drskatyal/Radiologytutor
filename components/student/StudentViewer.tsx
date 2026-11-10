"use client";

// The imaging stage of the student session: the shared reading frame
// (components/viewer/ViewerFrame.tsx) over the case's archive series, with
// the session's teaching layer on top — the animated finding marker, authored
// calipers, the tutor's laser and sketches, and a locate hit-layer that
// captures clicks during viva so we can grade "click the finding" against the
// authored marker. Optionally a second pane for a compare landing (prior /
// other series / other slice). The session keeps driving each pane through
// its own handle refs (lib/teachingLayer bindControls).

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { Skeleton, Spinner } from "@/components/ui";
import { ViewerFrame, type FrameInitialView } from "@/components/viewer/ViewerFrame";
import type { OpenSlice } from "@/lib/viewerLoad";
import type { CaseSeries, ViewerSource } from "@/lib/viewerSource";
import type { FindingMeasurement, Marker } from "@/lib/types";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { ReplayOverlay, type ReplayOverlayHandle } from "@/components/ReplayOverlay";
import type { SketchFrame } from "@/lib/sketchProjection";
import type { SketchMark } from "@/lib/sketchMarks";
import type { TeachingLayer } from "@/lib/teachingLayer";
import { FindingMarker } from "./FindingMarker";
import { MeasurementOverlay } from "./MeasurementOverlay";
import { ImageRectLayer } from "./ImageRectLayer";
import { SketchOverlay } from "./SketchOverlay";

export interface ViewerPane {
  source: ViewerSource;
  series?: CaseSeries[];
  activeSeriesIndex?: number;
  onSeriesChange?: (seriesInstanceUID: string) => void;
  controls: MutableRefObject<CornerstoneControls | null>;
  overlay: MutableRefObject<ReplayOverlayHandle | null>;
  onReady: (c: CornerstoneControls) => void;
  marker: Marker | null;
  markerVisible: boolean;
  /** Authored calipers to redraw ([0,1] handles). */
  measurements?: FindingMeasurement[];
  measurementsVisible?: boolean;
  ready: boolean;
  instanceId: string;
  label?: string;
}

export function StudentViewer({
  source,
  series,
  activeSeriesIndex = 0,
  onSeriesChange,
  openSlice = null,
  controls,
  overlay,
  onReady,
  marker,
  markerVisible,
  measurements,
  measurementsVisible,
  replaying,
  ready,
  locateMode = false,
  onLocateClick,
  sketches = [],
  onImagePoint,
  secondary,
  dock,
}: {
  /** The primary stack when the case has no series list (kept for callers; the frame reads `series`). */
  source: ViewerSource;
  series?: CaseSeries[];
  activeSeriesIndex?: number;
  onSeriesChange?: (seriesInstanceUID: string) => void;
  /** First landing for the primary pane. Compare stays at mid-stack. */
  openSlice?: OpenSlice | null;
  modality?: string;
  controls: MutableRefObject<CornerstoneControls | null>;
  overlay: MutableRefObject<ReplayOverlayHandle | null>;
  onReady: (c: CornerstoneControls) => void;
  marker: Marker | null;
  markerVisible: boolean;
  measurements?: FindingMeasurement[];
  measurementsVisible?: boolean;
  replaying: boolean;
  ready: boolean;
  /** Viva: student clicks the image to locate the finding. */
  locateMode?: boolean;
  onLocateClick?: (x: number, y: number) => void;
  /** Hand-drawn tutor marks, in image fractions. */
  sketches?: readonly SketchMark[];
  /** A short click on the image, already in image fractions. */
  onImagePoint?: (point: { x_pct: number; y_pct: number }, sliceIndex: number) => void;
  /** When set, a second stack opens beside the primary (compare). */
  secondary?: ViewerPane | null;
  /** Kept reachable while the stage is full screen (the microphone). */
  dock?: ReactNode;
}) {
  const rail = useMemo(() => series ?? [], [series]);
  const primaryUid = rail[Math.min(activeSeriesIndex, Math.max(0, rail.length - 1))]?.seriesInstanceUID;
  // Read once by the frame: where the primary pane opens.
  const openSliceRef = useRef(openSlice);
  openSliceRef.current = openSlice;
  const firstUid = useRef(primaryUid).current;
  const initial = useMemo<FrameInitialView>(
    () => ({
      seriesInstanceUID: firstUid,
      openSlice: (uid) => (uid === firstUid ? openSliceRef.current : null),
    }),
    [firstUid]
  );

  // Pane boxes and sketch frames, for clicks in image fractions.
  const hitRefs = useRef<Array<HTMLDivElement | null>>([]);
  const frames = useRef<Array<SketchFrame | null>>([]);

  // Callbacks read through refs so the layer object changes only with what it draws.
  const live = useRef({ onReady, onSeriesChange, onImagePoint, onLocateClick, secondary });
  live.current = { onReady, onSeriesChange, onImagePoint, onLocateClick, secondary };

  const compareUid = secondary
    ? (secondary.series ?? rail)[secondary.activeSeriesIndex ?? 0]?.seriesInstanceUID ?? null
    : null;

  const bindControls = useCallback(
    (pane: number) => (pane === 0 ? controls : pane === 1 ? (live.current.secondary?.controls ?? null) : null),
    [controls]
  );

  const paneOverlay = useCallback(
    (pane: number) => {
      const isPrimary = pane === 0;
      const p = isPrimary
        ? { controls, overlay, marker, markerVisible, measurements, measurementsVisible, ready, replaying }
        : secondary
          ? {
              controls: secondary.controls,
              overlay: secondary.overlay,
              marker: secondary.marker,
              markerVisible: secondary.markerVisible,
              measurements: secondary.measurements,
              measurementsVisible: secondary.measurementsVisible,
              ready: secondary.ready,
              replaying: false,
            }
          : null;
      if (!p) return null;
      const marks = isPrimary ? sketches : [];
      return (
        <div
          ref={(el) => {
            hitRefs.current[pane] = el;
          }}
          className="pointer-events-none absolute inset-0"
        >
          {/* Marker, calipers and laser are image fractions: lay them over
              the displayed image, not the letterboxed viewport. The frame
              hides this whole layer while MPR owns the pane. */}
          <ImageRectLayer controls={p.controls}>
            {p.marker && marks.length === 0 && <FindingMarker marker={p.marker} visible={p.markerVisible} />}
            {p.measurements && p.measurements.length > 0 && marks.length === 0 && (
              <MeasurementOverlay measurements={p.measurements} visible={Boolean(p.measurementsVisible)} />
            )}
            <ReplayOverlay
              ref={(h) => {
                p.overlay.current = h;
              }}
              active={p.replaying}
              tone="ink"
            />
          </ImageRectLayer>
          <SketchOverlay
            marks={marks}
            controls={p.controls}
            onFrame={(frame) => {
              frames.current[pane] = frame;
            }}
          />
          {isPrimary && locateMode && onLocateClick && (
            <button
              type="button"
              aria-label="Click the finding on the image"
              className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair bg-transparent"
              onClick={(e) => {
                const el = hitRefs.current[0];
                if (!el) return;
                const r = el.getBoundingClientRect();
                const x = (e.clientX - r.left) / r.width;
                const y = (e.clientY - r.top) / r.height;
                if (x < 0 || x > 1 || y < 0 || y > 1) return;
                live.current.onLocateClick?.(x, y);
              }}
            />
          )}
          {!p.ready && <ViewerSkeleton label="Warming images…" />}
        </div>
      );
    },
    [controls, overlay, marker, markerVisible, measurements, measurementsVisible, ready, replaying, secondary, sketches, locateMode, onLocateClick]
  );

  const teaching = useMemo<TeachingLayer>(
    () => ({
      defaultTool: "StackScroll",
      bindControls,
      overlay: (pane) => paneOverlay(pane.index),
      onViewer: (_viewer, pane) => {
        if (pane.index === 0 && controls.current) live.current.onReady(controls.current);
        const second = live.current.secondary;
        if (pane.index === 1 && second?.controls.current) second.onReady(second.controls.current);
      },
      onSeriesChange: (uid) => live.current.onSeriesChange?.(uid),
      compare: compareUid ? { seriesInstanceUID: compareUid, label: secondary?.label ?? "Compare" } : null,
      onPaneClick: (pane, point) => {
        const handler = live.current.onImagePoint;
        const frame = frames.current[pane.index];
        const box = hitRefs.current[pane.index]?.getBoundingClientRect();
        if (!handler || pane.index !== 0 || !frame || !box) return;
        const image = frame.unproject(point.clientX - box.left, point.clientY - box.top);
        if (image) handler(image, frame.sliceIndex);
      },
      dock,
    }),
    [bindControls, paneOverlay, controls, compareUid, secondary?.label, dock]
  );

  // Compare close changes the primary pane's size without remounting it.
  // Ask the live viewport to resize onto that pane and keep the teach window.
  const compareWasOpen = useRef(false);
  useEffect(() => {
    const wasOpen = compareWasOpen.current;
    compareWasOpen.current = !!compareUid;
    if (wasOpen && !compareUid) controls.current?.restoreLayout();
  }, [compareUid, controls]);

  const frameSource = useMemo(() => ({ kind: "cloud" as const, series: rail }), [rail]);
  void source;

  return (
    <div className="viewer-shell flex h-full w-full min-w-0 flex-col overflow-hidden bg-imaging">
      <ViewerFrame tone="reading" source={frameSource} teaching={teaching} initial={initial} />
    </div>
  );
}

function ViewerSkeleton({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-imaging">
      <Skeleton className="absolute inset-0 rounded-none bg-elevated/30" />
      <div className="relative flex items-center gap-2 text-sm text-white">
        <Spinner size="sm" label={label} />
        {label}
      </div>
    </div>
  );
}
