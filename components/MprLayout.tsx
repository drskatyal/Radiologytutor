"use client";

// Three orthographic planes. Rendered only after the user chooses MPR.
// Until the volume is live the grid keeps its layout size (so Cornerstone
// can attach viewports) but does not take pointer events, and the stack
// underneath stays usable when reconstruction isn't possible.

import type { RefObject } from "react";
import { Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { MPR_REFERENCE_LINE, type MprPlane } from "@/lib/mpr";

// Default MPR cameras (radiological convention): axial looks from the feet,
// coronal from the front, sagittal from the patient's left.
const PLANE_MARKERS: Record<MprPlane, { top: string; bottom: string; left: string; right: string }> = {
  axial: { top: "A", bottom: "P", left: "R", right: "L" },
  coronal: { top: "H", bottom: "F", left: "R", right: "L" },
  sagittal: { top: "H", bottom: "F", left: "A", right: "P" },
};

const shadow = "[text-shadow:0_0_3px_rgba(0,0,0,1),0_1px_1px_rgba(0,0,0,1)]";

function Plane({
  plane,
  label,
  nodeRef,
  tool,
  showLabels,
}: {
  plane: MprPlane;
  label: string;
  nodeRef: RefObject<HTMLDivElement>;
  tool: string;
  showLabels: boolean;
}) {
  const markers = PLANE_MARKERS[plane];
  const marker = cn(
    "pointer-events-none absolute z-[1] select-none text-xs font-semibold text-white/75",
    shadow
  );
  return (
    <div className="relative min-h-0 min-w-0 bg-imaging">
      <div
        ref={nodeRef}
        data-viewer-tool={tool}
        className="absolute inset-0"
        role="img"
        aria-label={`${label} plane`}
        onContextMenu={(event) => event.preventDefault()}
      />
      {showLabels ? (
        <>
          {/* The plane's name in the same color as its crosshair line, so
              "which line is the coronal?" is answered by looking. */}
          <span
            className={cn(
              "pointer-events-none absolute left-2 top-2 z-[1] flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/90",
              shadow
            )}
          >
            <span
              aria-hidden="true"
              className="h-2.5 w-0.5 rounded-full"
              style={{ backgroundColor: MPR_REFERENCE_LINE[plane] }}
            />
            {label}
          </span>
          <span aria-hidden="true" className={cn(marker, "left-1/2 top-1.5 -translate-x-1/2")}>
            {markers.top}
          </span>
          <span aria-hidden="true" className={cn(marker, "bottom-1.5 left-1/2 -translate-x-1/2")}>
            {markers.bottom}
          </span>
          <span aria-hidden="true" className={cn(marker, "left-2 top-1/2 -translate-y-1/2")}>
            {markers.left}
          </span>
          <span aria-hidden="true" className={cn(marker, "right-2 top-1/2 -translate-y-1/2")}>
            {markers.right}
          </span>
        </>
      ) : null}
    </div>
  );
}

export function MprLayout({
  axialRef,
  coronalRef,
  sagittalRef,
  tool,
  live,
  loading,
  notice,
  framed = false,
  showLabels = true,
}: {
  axialRef: RefObject<HTMLDivElement>;
  coronalRef: RefObject<HTMLDivElement>;
  sagittalRef: RefObject<HTMLDivElement>;
  /** Active left-button tool. Scroll and window/level drop the library crosshair. */
  tool: string;
  /** False while the volume is still mounting — the grid keeps its size so the viewports can render. */
  live: boolean;
  loading: boolean;
  notice: string | null;
  /** Docked stack chrome (radius + border) moves here once the planes are live. */
  framed?: boolean;
  /** Plane names and orientation letters; follows the overlay toggle. */
  showLabels?: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-[1]",
        !live && "pointer-events-none",
        framed && "overflow-hidden rounded-lg border border-[#1F1F1F]"
      )}
      data-mpr-layout={live ? "live" : "pending"}
    >
      <div
        className={cn(
          "grid h-full w-full grid-cols-1 grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)] gap-px bg-[#1F1F1F]",
          !live && "invisible"
        )}
      >
        <Plane plane="axial" label="Axial" nodeRef={axialRef} tool={tool} showLabels={showLabels} />
        <div className="grid min-h-0 grid-cols-2 gap-px bg-[#1F1F1F]">
          <Plane plane="coronal" label="Coronal" nodeRef={coronalRef} tool={tool} showLabels={showLabels} />
          <Plane plane="sagittal" label="Sagittal" nodeRef={sagittalRef} tool={tool} showLabels={showLabels} />
        </div>
      </div>
      {loading && (
        <div className="pointer-events-auto absolute inset-0 z-[2] flex items-center justify-center bg-black/70">
          <span className="flex items-center gap-2 rounded-md bg-black/80 px-3 py-1.5 text-xs text-white ring-1 ring-white/15">
            <Spinner size="sm" label="Loading volume" className="text-white" />
            Loading volume…
          </span>
        </div>
      )}
      {notice && !live && (
        <p
          role="status"
          className="absolute inset-x-3 bottom-3 z-[2] rounded-lg bg-black/80 px-3 py-2 text-xs leading-relaxed text-white ring-1 ring-white/15"
        >
          {notice}
        </p>
      )}
    </div>
  );
}
