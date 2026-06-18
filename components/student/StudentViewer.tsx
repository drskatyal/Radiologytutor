"use client";

// The imaging stage of the student session: our self-hosted Cornerstone viewer
// (dynamically imported, ssr:false — it needs WebGL/DOM/workers) plus the
// animated finding-marker overlay. The viewer fills a pure-black imaging
// surface; a shimmer skeleton covers it until the series is decoded so the
// panel is never blank (CLAUDE.md §0/§4a).

import dynamic from "next/dynamic";
import { type MutableRefObject } from "react";
import { Skeleton, Spinner } from "@/components/ui";
import type { ViewerSource } from "@/lib/viewerSource";
import type { Marker } from "@/lib/types";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { FindingMarker } from "./FindingMarker";

const CornerstoneViewer = dynamic(() => import("@/components/CornerstoneViewer"), {
  ssr: false,
  loading: () => <ViewerSkeleton label="Loading viewer…" />,
});

export function StudentViewer({
  source,
  controls,
  onReady,
  marker,
  markerVisible,
  ready,
}: {
  source: ViewerSource;
  controls: MutableRefObject<CornerstoneControls | null>;
  onReady: (c: CornerstoneControls) => void;
  marker: Marker | null;
  markerVisible: boolean;
  ready: boolean;
}) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-imaging">
      <CornerstoneViewer
        source={source}
        controls={controls}
        showToolbar={false}
        onReady={onReady}
        className="h-full w-full bg-imaging"
      />

      {/* Marker overlay — non-interactive so the viewer keeps mouse control. */}
      <div className="pointer-events-none absolute inset-0">
        {marker && <FindingMarker marker={marker} visible={markerVisible} />}
      </div>

      {/* Warming skeleton until the series is decoded. */}
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
