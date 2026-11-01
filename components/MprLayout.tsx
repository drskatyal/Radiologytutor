"use client";

// Three orthographic planes. Rendered only after the user chooses MPR.
// Until the volume is live the grid keeps its layout size (so Cornerstone
// can attach viewports) but does not take pointer events, and the stack
// underneath stays usable when reconstruction isn't possible.

import { useEffect, useRef, useState, type RefObject } from "react";
import { Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { MPR_REFERENCE_LINE, type MprPlane, type MprRender } from "@/lib/mpr";

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
  onPointer,
  className,
  readout,
}: {
  readout?: string | null;
  onPointer?: (plane: MprPlane) => void;
  className?: string;
  plane: MprPlane;
  label: string;
  nodeRef: RefObject<HTMLDivElement>;
  tool: string;
  showLabels: boolean;
}) {
  const markers = PLANE_MARKERS[plane];
  // A small black backing: the crosshair lines meet the edges exactly
  // where these letters sit.
  const marker = cn(
    "pointer-events-none absolute z-[1] select-none rounded-sm bg-black/75 px-1 text-xs font-semibold leading-4 text-white/80"
  );
  return (
    <div
      className={cn("relative min-h-0 min-w-0 bg-imaging", className)}
      onPointerDownCapture={() => onPointer?.(plane)}
    >
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
          {readout ? (
            <span
              className={cn(
                "pointer-events-none absolute right-2 top-2 z-[1] text-[11px] font-medium tabular-nums text-white/90 sm:text-xs",
                shadow
              )}
            >
              {readout}
            </span>
          ) : null}
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
  render = "mpr",
  volume3dRef,
  onPlanePointer,
  axialReadout,
  volume3dControls,
}: {
  /** Controls drawn over the 3D view (render look, cut plane). */
  volume3dControls?: React.ReactNode;
  /** "Im 42 / 240  W 400 L 40" — drawn in the axial plane's corner. */
  axialReadout?: string | null;
  render?: MprRender;
  volume3dRef?: RefObject<HTMLDivElement>;
  onPlanePointer?: (plane: MprPlane) => void;
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
  // Wide panes put axial on the left at two thirds of the width, coronal and
  // sagittal stacked on the right — an axial slice is roughly square, so a
  // full-width axial row was mostly black side bars. Tall panes (a phone)
  // keep axial on top. One flat grid, so the plane elements Cornerstone is
  // attached to never remount when the layout flips.
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width > 0 && height > 0) setWide(width / height >= 1.15);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const show3d = render === "3d";

  return (
    <div
      ref={rootRef}
      className={cn(
        "absolute inset-0 z-[1]",
        !live && "pointer-events-none",
        framed && "overflow-hidden rounded-lg border border-[#1F1F1F]"
      )}
      data-mpr-layout={live ? "live" : "pending"}
      data-mpr-render={render}
    >
      <div
        className={cn(
          "grid h-full w-full gap-px bg-[#1F1F1F]",
          wide
            ? "grid-cols-[minmax(0,2fr)_minmax(0,1fr)] grid-rows-2"
            : "grid-cols-2 grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)]",
          (!live || show3d) && "invisible"
        )}
      >
        <Plane
          plane="axial"
          label="Axial"
          nodeRef={axialRef}
          tool={tool}
          showLabels={showLabels}
          onPointer={onPlanePointer}
          readout={axialReadout}
          className={wide ? "row-span-2" : "col-span-2"}
        />
        <Plane plane="coronal" label="Coronal" nodeRef={coronalRef} tool={tool} showLabels={showLabels} onPointer={onPlanePointer} />
        <Plane plane="sagittal" label="Sagittal" nodeRef={sagittalRef} tool={tool} showLabels={showLabels} onPointer={onPlanePointer} />
      </div>
      {volume3dRef ? (
        // Always laid out (Cornerstone needs a measured element to enable the
        // 3D viewport); only visible in 3D.
        <div className={cn("absolute inset-0 bg-imaging", !show3d && "invisible pointer-events-none")}>
          <div
            ref={volume3dRef}
            className="absolute inset-0"
            role="img"
            aria-label="3D volume render"
            onContextMenu={(event) => event.preventDefault()}
          />
          {show3d && showLabels ? (
            <span className="pointer-events-none absolute left-2 top-2 text-[11px] font-semibold uppercase tracking-wide text-white/85 [text-shadow:0_0_3px_rgba(0,0,0,1)]">
              3D · drag to rotate
            </span>
          ) : null}
          {show3d && volume3dControls ? (
            <div className="absolute right-2 top-2 flex items-center gap-2 rounded-md bg-black/70 px-2 py-1 text-[11px] text-white ring-1 ring-white/15">
              {volume3dControls}
            </div>
          ) : null}
        </div>
      ) : null}
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
