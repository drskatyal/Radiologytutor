"use client";

// The imaging stage of the student session: our self-hosted Cornerstone viewer
// (dynamically imported, ssr:false — it needs WebGL/DOM/workers) plus the
// animated finding-marker overlay. Optionally a second pane for a compare
// landing (prior / other series / other slice). A locate hit-layer captures
// clicks during viva so we can grade "click the finding" against the authored
// marker — no new imaging infra.

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type MouseEvent, type MutableRefObject } from "react";
import { Skeleton, Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { OpenSlice } from "@/lib/viewerLoad";
import type { CaseSeries, ViewerSource } from "@/lib/viewerSource";
import type { FindingMeasurement, Marker } from "@/lib/types";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { ReplayOverlay, type ReplayOverlayHandle } from "@/components/ReplayOverlay";
import type { SketchFrame } from "@/lib/sketchProjection";
import type { SketchMark } from "@/lib/sketchMarks";
import { FindingMarker } from "./FindingMarker";
import { MeasurementOverlay } from "./MeasurementOverlay";
import { ImageRectLayer } from "./ImageRectLayer";
import { SketchOverlay } from "./SketchOverlay";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => <ViewerSkeleton label="Loading viewer…" />,
});

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
  activeSeriesIndex,
  onSeriesChange,
  openSlice = null,
  modality,
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
}: {
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
}) {
  const compare = !!secondary;
  // Compare close changes the primary pane's size without remounting it.
  // Ask the live viewport to resize onto that pane and keep the teach window.
  const compareWasOpen = useRef(false);
  useEffect(() => {
    const wasOpen = compareWasOpen.current;
    compareWasOpen.current = compare;
    if (wasOpen && !compare) controls.current?.restoreLayout();
  }, [compare, controls]);

  // Compare shares ONE toolbar under both panes; it acts on the pane the
  // reader last touched (outlined). A lone pane keeps its own bar. The tree
  // shape is the same either way so the primary viewport never remounts.
  const [barHost, setBarHost] = useState<HTMLDivElement | null>(null);
  const [activePane, setActivePane] = useState(0);
  useEffect(() => {
    if (!compare) setActivePane(0);
  }, [compare]);

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-imaging">
    <div
      className={cn(
        "relative min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-imaging",
        compare && "grid gap-px bg-[#1F1F1F] grid-rows-2 lg:grid-cols-2 lg:grid-rows-1"
      )}
    >
      <ImagingPane
        toolbarHost={compare ? barHost : undefined}
        active={!compare || activePane === 0}
        outlined={compare && activePane === 0}
        onActivate={() => setActivePane(0)}
        source={source}
        series={series}
        activeSeriesIndex={activeSeriesIndex}
        onSeriesChange={onSeriesChange}
        openSlice={openSlice}
        modality={modality}
        controls={controls}
        overlay={overlay}
        onReady={onReady}
        marker={marker}
        markerVisible={markerVisible}
        measurements={measurements}
        measurementsVisible={measurementsVisible}
        replaying={replaying}
        ready={ready}
        instanceId="primary"
        label={compare ? "Current" : undefined}
        locateMode={locateMode}
        onLocateClick={onLocateClick}
        sketches={sketches}
        onImagePoint={onImagePoint}
      />
      {secondary && (
        <ImagingPane
          toolbarHost={barHost}
          active={activePane === 1}
          outlined={activePane === 1}
          onActivate={() => setActivePane(1)}
          source={secondary.source}
          series={secondary.series}
          activeSeriesIndex={secondary.activeSeriesIndex}
          onSeriesChange={secondary.onSeriesChange}
          modality={modality}
          controls={secondary.controls}
          overlay={secondary.overlay}
          onReady={secondary.onReady}
          marker={secondary.marker}
          markerVisible={secondary.markerVisible}
          measurements={secondary.measurements}
          measurementsVisible={secondary.measurementsVisible}
          replaying={false}
          ready={secondary.ready}
          instanceId={secondary.instanceId}
          label={secondary.label ?? "Compare"}
        />
      )}
    </div>
    {compare ? <div ref={setBarHost} className="shrink-0" /> : null}
    </div>
  );
}

function ImagingPane({
  source,
  series,
  activeSeriesIndex,
  onSeriesChange,
  openSlice = null,
  modality,
  controls,
  overlay,
  onReady,
  marker,
  markerVisible,
  measurements,
  measurementsVisible,
  replaying,
  ready,
  instanceId,
  label,
  locateMode,
  onLocateClick,
  sketches = [],
  onImagePoint,
  toolbarHost,
  active = true,
  outlined = false,
  onActivate,
}: {
  toolbarHost?: HTMLElement | null;
  active?: boolean;
  outlined?: boolean;
  onActivate?: () => void;
  source: ViewerSource;
  series?: CaseSeries[];
  activeSeriesIndex?: number;
  onSeriesChange?: (seriesInstanceUID: string) => void;
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
  instanceId: string;
  label?: string;
  locateMode?: boolean;
  onLocateClick?: (x: number, y: number) => void;
  sketches?: readonly SketchMark[];
  onImagePoint?: (point: { x_pct: number; y_pct: number }, sliceIndex: number) => void;
}) {
  const hitRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<SketchFrame | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  // Markers and the laser are stored in stack-image fractions. Hide them
  // while MPR is up so they are not drawn across the three planes.
  const [layout, setLayout] = useState<"stack" | "mpr">("stack");
  const stackOverlay = layout === "stack";

  function handleLocate(e: MouseEvent<HTMLButtonElement>) {
    const el = hitRef.current;
    if (!el || !onLocateClick) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    onLocateClick(x, y);
  }

  return (
    <div
      data-viewer-root
      className="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-imaging"
      onPointerDown={(event) => {
        downRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = downRef.current;
        downRef.current = null;
        if (!start || !onImagePoint) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
        const frame = frameRef.current;
        if (!frame) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const image = frame.unproject(event.clientX - rect.left, event.clientY - rect.top);
        if (!image) return;
        onImagePoint(image, frame.sliceIndex);
      }}
    >
      <CornerstoneViewer
        source={source}
        series={series}
        activeSeriesIndex={activeSeriesIndex}
        onSeriesChange={onSeriesChange}
        openSlice={openSlice}
        modality={modality}
        controls={controls}
        showToolbar={false}
        chrome="edge"
        defaultTool="StackScroll"
        onReady={onReady}
        instanceId={instanceId}
        className="h-full w-full bg-imaging"
        onViewModeChange={setLayout}
        toolbarHost={toolbarHost}
        active={active}
        onActivate={onActivate}
        paneLabel={label}
      />

      <div ref={hitRef} className="pointer-events-none absolute inset-0">
        {stackOverlay && (
          // Marker, calipers and laser are image fractions: lay them over
          // the displayed image, not the letterboxed viewport.
          <ImageRectLayer controls={controls}>
            {marker && sketches.length === 0 && (
              <FindingMarker marker={marker} visible={markerVisible} />
            )}
            {measurements && measurements.length > 0 && sketches.length === 0 && (
              <MeasurementOverlay
                measurements={measurements}
                visible={Boolean(measurementsVisible)}
              />
            )}
            <ReplayOverlay
              ref={(h) => {
                overlay.current = h;
              }}
              active={replaying}
              tone="ink"
            />
          </ImageRectLayer>
        )}
        {stackOverlay && (
          <SketchOverlay
            marks={sketches}
            controls={controls}
            onFrame={(frame) => {
              frameRef.current = frame;
            }}
          />
        )}
        {locateMode && onLocateClick && (
          <button
            type="button"
            aria-label="Click the finding on the image"
            className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair bg-transparent"
            onClick={handleLocate}
          />
        )}
      </div>

      {outlined ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 shadow-[inset_0_0_0_1.5px_rgb(var(--accent))]"
        />
      ) : null}

      {!ready && <ViewerSkeleton label="Warming images…" />}
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
