"use client";

// The imaging stage of the student session: our self-hosted Cornerstone viewer
// (dynamically imported, ssr:false — it needs WebGL/DOM/workers) plus the
// animated finding-marker overlay. Optionally a second pane for a compare
// landing (prior / other series / other slice). A locate hit-layer captures
// clicks during viva so we can grade "click the finding" against the authored
// marker — no new imaging infra.

import dynamic from "next/dynamic";
import { useRef, type MouseEvent, type MutableRefObject } from "react";
import { Skeleton, Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { CaseSeries, ViewerSource } from "@/lib/viewerSource";
import type { Marker } from "@/lib/types";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { ReplayOverlay, type ReplayOverlayHandle } from "@/components/ReplayOverlay";
import { FindingMarker } from "./FindingMarker";

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
  ready: boolean;
  instanceId: string;
  label?: string;
}

export function StudentViewer({
  source,
  series,
  activeSeriesIndex,
  onSeriesChange,
  modality,
  controls,
  overlay,
  onReady,
  marker,
  markerVisible,
  replaying,
  ready,
  locateMode = false,
  onLocateClick,
  secondary,
}: {
  source: ViewerSource;
  series?: CaseSeries[];
  activeSeriesIndex?: number;
  onSeriesChange?: (seriesInstanceUID: string) => void;
  modality?: string;
  controls: MutableRefObject<CornerstoneControls | null>;
  overlay: MutableRefObject<ReplayOverlayHandle | null>;
  onReady: (c: CornerstoneControls) => void;
  marker: Marker | null;
  markerVisible: boolean;
  replaying: boolean;
  ready: boolean;
  /** Viva: student clicks the image to locate the finding. */
  locateMode?: boolean;
  onLocateClick?: (x: number, y: number) => void;
  /** When set, a second stack opens beside the primary (compare). */
  secondary?: ViewerPane | null;
}) {
  const compare = !!secondary;

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden bg-imaging",
        compare && "grid grid-cols-1 md:grid-cols-2"
      )}
    >
      <ImagingPane
        source={source}
        series={series}
        activeSeriesIndex={activeSeriesIndex}
        onSeriesChange={onSeriesChange}
        modality={modality}
        controls={controls}
        overlay={overlay}
        onReady={onReady}
        marker={marker}
        markerVisible={markerVisible}
        replaying={replaying}
        ready={ready}
        instanceId="primary"
        label={compare ? "Current" : undefined}
        locateMode={locateMode}
        onLocateClick={onLocateClick}
      />
      {secondary && (
        <ImagingPane
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
          replaying={false}
          ready={secondary.ready}
          instanceId={secondary.instanceId}
          label={secondary.label ?? "Compare"}
        />
      )}
    </div>
  );
}

function ImagingPane({
  source,
  series,
  activeSeriesIndex,
  onSeriesChange,
  modality,
  controls,
  overlay,
  onReady,
  marker,
  markerVisible,
  replaying,
  ready,
  instanceId,
  label,
  locateMode,
  onLocateClick,
}: {
  source: ViewerSource;
  series?: CaseSeries[];
  activeSeriesIndex?: number;
  onSeriesChange?: (seriesInstanceUID: string) => void;
  modality?: string;
  controls: MutableRefObject<CornerstoneControls | null>;
  overlay: MutableRefObject<ReplayOverlayHandle | null>;
  onReady: (c: CornerstoneControls) => void;
  marker: Marker | null;
  markerVisible: boolean;
  replaying: boolean;
  ready: boolean;
  instanceId: string;
  label?: string;
  locateMode?: boolean;
  onLocateClick?: (x: number, y: number) => void;
}) {
  const hitRef = useRef<HTMLDivElement>(null);

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
    <div className="relative h-full w-full min-w-0 overflow-hidden bg-imaging md:border-r md:border-subtle/40 md:last:border-r-0">
      <CornerstoneViewer
        source={source}
        series={series}
        activeSeriesIndex={activeSeriesIndex}
        onSeriesChange={onSeriesChange}
        modality={modality}
        controls={controls}
        showToolbar={false}
        onReady={onReady}
        instanceId={instanceId}
        className="h-full w-full bg-imaging"
      />

      <div ref={hitRef} className="pointer-events-none absolute inset-0">
        {marker && <FindingMarker marker={marker} visible={markerVisible} />}
        <ReplayOverlay
          ref={(h) => {
            overlay.current = h;
          }}
          active={replaying}
        />
        {locateMode && onLocateClick && (
          <button
            type="button"
            aria-label="Click the finding on the image"
            className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair bg-transparent"
            onClick={handleLocate}
          />
        )}
      </div>

      {label && (
        <span className="pointer-events-none absolute left-2 top-2 z-20 rounded-md border border-strong/50 bg-elevated/85 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary">
          {label}
        </span>
      )}

      {!ready && <ViewerSkeleton label="Warming images…" />}
    </div>
  );
}

function ViewerSkeleton({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-imaging">
      <Skeleton className="absolute inset-0 rounded-none bg-elevated/30" />
      <div className="relative flex items-center gap-2.5 text-sm text-secondary">
        <Spinner size="sm" label={label} />
        {label}
      </div>
    </div>
  );
}
