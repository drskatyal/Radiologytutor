// Quick reformat: one coronal, sagittal or axial (slab) plane of a series in a
// normal layout viewport, without opening the full MPR or 3D. The plane is
// rendered by Rust from the shared native volume (volume.rs); the cell keeps
// its place in the layout, its active border and its drop target.
//
// Wheel pages through the plane (the slab position), Ctrl+wheel sets the slab
// thickness (Slice → MIP), drag windows, double-click resets, ✕ returns the
// viewport to its slices.

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { invoke } from "../platform";
import type { ViewerSeries } from "../types";
import { Pane, SLAB_MAX_MM, SLAB_MODES, depthOf, reducedNote, type Plane, type Slab, type SlabMode, type VolumeInfo } from "./NativeMprView";

const PLANE_LABEL: Record<Plane, string> = { axial: "Axial", coronal: "Coronal", sagittal: "Sagittal" };

interface Props {
  series: ViewerSeries;
  plane: Plane;
  cellIndex: number;
  active: boolean;
  dropHover?: boolean;
  onActivate: () => void;
  onClose: () => void;
  /** Slab mode change from outside (shortcut); bumps when it changes. */
  slabCommand?: { mode?: SlabMode; deltaMm?: number; seq: number };
  initialSlab?: Slab;
  /** Bench: the plane is on screen (brightest pixel). */
  onPainted?: (t: { ms: number; maxLum: Record<string, number>; slab: Slab }) => void;
}

export function NativePlaneView({ series, plane, cellIndex, active, dropHover, onActivate, onClose, slabCommand, initialSlab, onPainted }: Props) {
  const [info, setInfo] = useState<VolumeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [voi, setVoi] = useState({ center: 40, width: 400 });
  const [slab, setSlab] = useState<Slab>(initialSlab ?? { mode: "off", mm: 0 });
  const filesKey = useMemo(() => series.headers.map((h) => h.fileId).sort((a, b) => a - b).join(","), [series]);
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const opened = useRef(0);
  const painted = useRef(false);
  const paintedCb = useRef(onPainted);
  paintedCb.current = onPainted;
  const slabRef = useRef(slab);
  slabRef.current = slab;

  const reset = (v: VolumeInfo) => {
    setIndex(Math.floor(depthOf(v, plane) / 2));
    const h = seriesRef.current.headers[Math.floor(seriesRef.current.headers.length / 2)];
    if (h?.windowWidth && h.windowWidth > 1 && h.windowCenter != null) setVoi({ center: h.windowCenter, width: h.windowWidth });
    else if (v.window) setVoi({ center: v.window[0], width: v.window[1] });
    else setVoi({ center: (v.min + v.max) / 2, width: Math.max(1, v.max - v.min) });
  };

  useEffect(() => {
    let live = true;
    let key: string | null = null;
    opened.current = performance.now();
    painted.current = false;
    setInfo(null);
    setError(null);
    invoke<VolumeInfo>("volume_build", { fileIds: filesKey.split(",").map(Number) })
      .then((v) => {
        key = v.key;
        if (!live) return void invoke("volume_close", { key }).catch(() => undefined);
        reset(v);
        setInfo(v);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
      if (key) void invoke("volume_close", { key }).catch(() => undefined);
    };
    // The volume depends on the set of files only; the plane only on `plane`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey]);

  useEffect(() => {
    if (info) setIndex(Math.floor(depthOf(info, plane) / 2));
  }, [plane, info]);

  const changeSlab = (deltaMm: number) =>
    setSlab((s) => {
      const mm = Math.max(0, Math.min(SLAB_MAX_MM, s.mm + deltaMm));
      return { mode: mm === 0 ? "off" : s.mode === "off" ? "mip" : s.mode, mm };
    });

  // Shortcuts act on the active viewport: mode change or thickness step.
  useEffect(() => {
    if (!slabCommand || !active) return;
    if (slabCommand.mode) {
      const mode = slabCommand.mode;
      setSlab((s) => ({ mode, mm: mode === "off" ? 0 : s.mm || 10 }));
    }
    if (slabCommand.deltaMm) changeSlab(slabCommand.deltaMm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slabCommand?.seq]);

  const depth = info ? depthOf(info, plane) : 1;
  const at = info
    ? {
        axial: plane === "axial" ? index : Math.floor(info.dims[2] / 2),
        coronal: plane === "coronal" ? index : Math.floor(info.dims[1] / 2),
        sagittal: plane === "sagittal" ? index : Math.floor(info.dims[0] / 2),
      }
    : { axial: 0, coronal: 0, sagittal: 0 };

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-imaging outline outline-1 -outline-offset-1",
        active ? "outline-[3px] -outline-offset-[3px] outline-accent" : "outline-subtle",
        dropHover && "outline-[3px] -outline-offset-[3px] outline-accent-bright"
      )}
      data-drop-cell={cellIndex}
      data-active-viewport={active ? "1" : undefined}
      data-reformat={plane}
      onPointerDownCapture={onActivate}
    >
      {error ? (
        <div role="alert" className="flex flex-1 items-center justify-center px-4 text-center text-xs text-white/70">
          This series can&apos;t be reformatted: {error}
        </div>
      ) : !info ? (
        <div aria-busy="true" className="flex flex-1 items-center justify-center">
          <Spinner label={`Preparing ${PLANE_LABEL[plane].toLowerCase()} reformat`} />
        </div>
      ) : (
        <Pane
          info={info}
          plane={plane}
          label={`${PLANE_LABEL[plane]} reformat`}
          at={at}
          center={voi.center}
          width={voi.width}
          active={false}
          onActivate={onActivate}
          onScroll={(d) => setIndex((i) => Math.max(0, Math.min(depth - 1, i + d)))}
          onWindow={(dc, dw) => setVoi((v) => ({ center: v.center + dc, width: Math.max(1, v.width + dw) }))}
          onPoint={() => undefined}
          onReset={() => reset(info)}
          slab={slab}
          onSlab={changeSlab}
          crosshair={false}
          onPainted={(lum) => {
            if (painted.current) return;
            painted.current = true;
            paintedCb.current?.({ ms: performance.now() - opened.current, maxLum: { [plane]: lum }, slab: slabRef.current });
          }}
        />
      )}
      <div className="absolute right-1 top-1 z-10 flex items-center gap-1">
        {info && reducedNote(info) && <span className="rounded bg-black/60 px-1 text-[10px] text-warning">{reducedNote(info)}</span>}
        <span className="sr-only">Slab: {SLAB_MODES.find((m) => m.mode === slab.mode)?.label}</span>
        <IconButton aria-label="Back to slices" title="Back to slices (Esc)" size="sm" variant="imaging" onClick={onClose}>
          <X />
        </IconButton>
      </div>
    </div>
  );
}
