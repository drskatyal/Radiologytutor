"use client";

// Three orthographic planes. Rendered only after the user chooses MPR.
// Until the volume is live the grid keeps its layout size (so Cornerstone
// can attach viewports) but does not take pointer events, and the stack
// underneath stays usable when reconstruction isn't possible.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { IconButton, Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { MPR_REFERENCE_LINE, type MprPlane, type MprRender } from "@/lib/mpr";
import { EQUAL_SHARES as EQUAL, MIN_SHARE, moveSplit, type Shares } from "@/lib/mprSplit";

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
  style,
  readout,
  slab,
  maximized,
  onToggleMaximize,
  canDoubleClick,
}: {
  /** "MIP 10 mm" while a slab is on. */
  slab?: string | null;
  style?: React.CSSProperties;
  /** This plane fills the whole layout (the others stay mounted underneath). */
  maximized: boolean;
  onToggleMaximize: (plane: MprPlane) => void;
  /** False while an annotation tool owns double-click. */
  canDoubleClick: boolean;
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
      className={cn("relative min-h-0 min-w-0 bg-imaging", maximized && "!absolute inset-0 z-[3]", className)}
      style={style}
      data-mpr-plane={plane}
      data-maximized={maximized || undefined}
      onPointerDownCapture={() => onPointer?.(plane)}
      onDoubleClick={() => {
        if (canDoubleClick) onToggleMaximize(plane);
      }}
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
            {slab ? (
              <span className="rounded-sm bg-accent/25 px-1 py-px normal-case tracking-normal text-white" data-mpr-slab={slab}>
                {slab}
              </span>
            ) : null}
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
      <IconButton
        variant="imaging"
        size="sm"
        aria-label={maximized ? `Restore the ${label.toLowerCase()} plane to the grid` : `Enlarge the ${label.toLowerCase()} plane`}
        aria-pressed={maximized}
        title={maximized ? "Restore (double-click or Esc)" : "Enlarge (double-click)"}
        onClick={() => onToggleMaximize(plane)}
        onDoubleClick={(event) => event.stopPropagation()}
        className="absolute bottom-1.5 right-1.5 z-[2] bg-black/60"
      >
        {maximized ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
      </IconButton>
    </div>
  );
}

/** A draggable boundary between two planes; arrow keys move it, double-click evens the layout. */
function Splitter({
  index,
  vertical,
  rootRef,
  shares,
  onShares,
  style,
}: {
  index: 0 | 1;
  /** True when the planes sit side by side (the bar is vertical, drags left/right). */
  vertical: boolean;
  rootRef: RefObject<HTMLDivElement>;
  shares: Shares;
  onShares: (next: Shares) => void;
  style: React.CSSProperties;
}) {
  const drag = useRef<{ start: number; shares: Shares; size: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={index === 0 ? "Resize the first and second planes" : "Resize the second and third planes"}
      aria-valuemin={Math.round(MIN_SHARE * 100)}
      aria-valuemax={Math.round((shares[index] + shares[index + 1] - MIN_SHARE) * 100)}
      aria-valuenow={Math.round(shares[index] * 100)}
      tabIndex={0}
      data-mpr-splitter={index}
      style={style}
      className={cn(
        "group relative z-[2] touch-none bg-[#1F1F1F] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent",
        vertical ? "cursor-col-resize" : "cursor-row-resize"
      )}
      onPointerDown={(event) => {
        const box = rootRef.current?.getBoundingClientRect();
        if (!box) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { start: vertical ? event.clientX : event.clientY, shares, size: vertical ? box.width : box.height };
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || d.size <= 0) return;
        const delta = ((vertical ? event.clientX : event.clientY) - d.start) / d.size;
        onShares(moveSplit(d.shares, index, delta));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onShares(EQUAL);
      }}
      onKeyDown={(event) => {
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const fwd = vertical ? "ArrowRight" : "ArrowDown";
        if (event.key !== back && event.key !== fwd && event.key !== "Home") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Home") onShares(EQUAL);
        else onShares(moveSplit(shares, index, event.key === fwd ? 0.05 : -0.05));
      }}
    >
      {/* A wider invisible grab area than the 6 px bar. */}
      <span aria-hidden className={cn("absolute", vertical ? "inset-y-0 -left-1.5 -right-1.5" : "inset-x-0 -top-1.5 -bottom-1.5")} />
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
  slabLabel = null,
  volume3dRef,
  onPlanePointer,
  axialReadout,
  volume3dControls,
  maximized = null,
  onMaximize,
  onLayoutChange,
  canDoubleClick = true,
}: {
  /** The plane enlarged to fill the layout, or null for the grid. */
  maximized?: MprPlane | null;
  onMaximize?: (plane: MprPlane | null) => void;
  /** Panes changed size (split, maximise, window): refit the planes (session.fit). */
  onLayoutChange?: () => void;
  /** Double-click enlarges / restores a plane; false while an annotation tool owns double-click. */
  canDoubleClick?: boolean;
  /** Controls drawn over the 3D view (render look, cut plane). */
  volume3dControls?: React.ReactNode;
  /** "Im 42 / 240  W 400 L 40" — drawn in the axial plane's corner. */
  axialReadout?: string | null;
  render?: MprRender;
  /** "MIP 10 mm" on each plane while a slab is on. */
  slabLabel?: string | null;
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
  // Three equal panes, side by side when the layout is wide and stacked when
  // it is tall (a phone). Every pane is the same size so no plane is drawn
  // into a narrow strip; the two splitters resize them, double-click on a
  // plane enlarges it. One flat grid, so the plane elements Cornerstone is
  // attached to never remount when the layout flips.
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  const [shares, setShares] = useState<Shares>(EQUAL);
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

  // Refit the planes whenever any pane's box changes (one call per frame).
  const layoutChangeRef = useRef(onLayoutChange);
  layoutChangeRef.current = onLayoutChange;
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const nodes = [axialRef.current, coronalRef.current, sagittalRef.current].filter((n): n is HTMLDivElement => !!n);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => layoutChangeRef.current?.());
    });
    for (const node of nodes) observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [axialRef, coronalRef, sagittalRef]);

  const toggleMaximize = useCallback(
    (plane: MprPlane) => onMaximize?.(maximized === plane ? null : plane),
    [maximized, onMaximize]
  );
  // Esc restores the grid from an enlarged plane.
  useEffect(() => {
    if (!maximized || !onMaximize) return;
    // Capture phase: the viewport's own keys also handle Esc (cancel a tool),
    // so a bubbling listener never saw it while the image had focus. An open
    // menu or dialog keeps its Esc.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      onMaximize(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [maximized, onMaximize]);

  const show3d = render === "3d";
  const tracks = `minmax(0,${shares[0]}fr) 6px minmax(0,${shares[1]}fr) 6px minmax(0,${shares[2]}fr)`;
  const at = (n: 1 | 2 | 3 | 4 | 5): React.CSSProperties => (wide ? { gridColumn: n, gridRow: 1 } : { gridRow: n, gridColumn: 1 });
  const planeProps = {
    tool,
    showLabels,
    slab: slabLabel,
    onPointer: onPlanePointer,
    onToggleMaximize: toggleMaximize,
    canDoubleClick,
  };

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
      data-mpr-maximized={maximized ?? undefined}
    >
      <div
        className={cn("grid h-full w-full bg-[#1F1F1F]", (!live || show3d) && "invisible")}
        // Track sizes follow the splitters: a dynamic value, so inline.
        style={wide ? { gridTemplateColumns: tracks, gridTemplateRows: "minmax(0,1fr)" } : { gridTemplateRows: tracks, gridTemplateColumns: "minmax(0,1fr)" }}
      >
        <Plane
          plane="axial"
          label="Axial"
          nodeRef={axialRef}
          readout={axialReadout}
          maximized={maximized === "axial"}
          style={at(1)}
          {...planeProps}
        />
        <Plane plane="coronal" label="Coronal" nodeRef={coronalRef} maximized={maximized === "coronal"} style={at(3)} {...planeProps} />
        <Plane plane="sagittal" label="Sagittal" nodeRef={sagittalRef} maximized={maximized === "sagittal"} style={at(5)} {...planeProps} />
        {!maximized && (
          <>
            <Splitter index={0} vertical={wide} rootRef={rootRef} shares={shares} onShares={setShares} style={at(2)} />
            <Splitter index={1} vertical={wide} rootRef={rootRef} shares={shares} onShares={setShares} style={at(4)} />
          </>
        )}
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
