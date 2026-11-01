// Native MPR (Phase 1): the volume lives in Rust (src-tauri/src/volume.rs) as
// one 16-bit buffer; each pane shows a windowed 8-bit plane Rust renders on
// request. The webview holds three small PNGs, never the stack, the volume or
// a volume texture, so MPR costs the renderer next to nothing and closing it
// returns the volume's memory at once (volume_close).
//
// Interaction: wheel scrolls the pane's plane (Shift ×5), drag sets
// window/level, click moves the crosshair (the other two planes follow),
// arrow keys scroll the active pane, double-click resets.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { invoke, volumePlaneUrl } from "../platform";
import type { ViewerSeries } from "../types";

type Plane = "axial" | "coronal" | "sagittal";

export interface VolumeInfo {
  key: string;
  /** columns, rows, slices */
  dims: [number, number, number];
  /** mm: column, row, slice */
  spacing: [number, number, number];
  min: number;
  max: number;
  window: [number, number] | null;
  bytes: number;
  buildMs: number;
}

interface Props {
  series: ViewerSeries;
  onExit: () => void;
  /** The native core cannot read this series (e.g. JPEG-LS): use the GPU MPR. */
  onUnsupported?: () => void;
  onVolumeReady?: (t: { shellMs: number; loadedMs: number }) => void;
}

const PLANES: { plane: Plane; label: string }[] = [
  { plane: "axial", label: "Axial" },
  { plane: "sagittal", label: "Sagittal" },
  { plane: "coronal", label: "Coronal" },
];

/** Slice count along a plane's own axis. */
function depthOf(info: VolumeInfo, plane: Plane): number {
  return plane === "axial" ? info.dims[2] : plane === "coronal" ? info.dims[1] : info.dims[0];
}

/** Physical width / height (mm) of a plane's image. */
function mmOf(info: VolumeInfo, plane: Plane): [number, number] {
  const [nx, ny, nz] = info.dims;
  const [sx, sy, sz] = info.spacing;
  if (plane === "axial") return [nx * sx, ny * sy];
  if (plane === "coronal") return [nx * sx, nz * sz];
  return [ny * sy, nz * sz];
}

/** Crosshair as fractions of the plane image (x from left, y from top). */
function crosshair(info: VolumeInfo, plane: Plane, at: Record<Plane, number>): [number, number] {
  const [nx, ny, nz] = info.dims;
  const top = (z: number) => 1 - (z + 0.5) / nz; // last slice at the top
  if (plane === "axial") return [(at.sagittal + 0.5) / nx, (at.coronal + 0.5) / ny];
  if (plane === "coronal") return [(at.sagittal + 0.5) / nx, top(at.axial)];
  return [(at.coronal + 0.5) / ny, top(at.axial)];
}

/** Latest-wins image loading: no flicker, never a queue of stale planes. */
function usePlaneImage(url: string | null): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const wanted = useRef<string | null>(null);
  const load = useCallback(() => {
    const next = wanted.current;
    if (!next || busy.current) return;
    busy.current = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      busy.current = false;
      setSrc(next);
      setFailed(false);
      if (wanted.current !== next) load();
    };
    img.onerror = () => {
      busy.current = false;
      setFailed(true);
      if (wanted.current !== next) load();
    };
    img.src = next;
  }, []);
  useEffect(() => {
    wanted.current = url;
    load();
  }, [url, load]);
  return { src, failed };
}

function Pane({
  info,
  plane,
  label,
  at,
  center,
  width,
  active,
  onActivate,
  onScroll,
  onWindow,
  onPoint,
  onReset,
}: {
  info: VolumeInfo;
  plane: Plane;
  label: string;
  at: Record<Plane, number>;
  center: number;
  width: number;
  active: boolean;
  onActivate: () => void;
  onScroll: (delta: number) => void;
  onWindow: (dCenter: number, dWidth: number) => void;
  onPoint: (fx: number, fy: number) => void;
  onReset: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [mmW, mmH] = mmOf(info, plane);
  // The image rect inside the pane (object-contain), for the crosshair.
  const scale = size[0] && size[1] ? Math.min(size[0] / mmW, size[1] / mmH) : 0;
  const rect = { w: mmW * scale, h: mmH * scale, x: (size[0] - mmW * scale) / 2, y: (size[1] - mmH * scale) / 2 };
  const maxDim = Math.min(1024, Math.max(128, Math.ceil(Math.max(rect.w, rect.h) * (window.devicePixelRatio || 1))));
  const url = scale ? volumePlaneUrl(info.key, plane, at[plane], center, width, maxDim) : null;
  const { src, failed } = usePlaneImage(url);
  const [cx, cy] = crosshair(info, plane, at);

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  return (
    <div
      ref={box}
      role="img"
      aria-label={`${label}, slice ${at[plane] + 1} of ${depthOf(info, plane)}`}
      tabIndex={0}
      onFocus={onActivate}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowRight") onScroll(1);
        else if (e.key === "ArrowDown" || e.key === "ArrowLeft") onScroll(-1);
        else return;
        e.preventDefault();
      }}
      onWheel={(e) => onScroll((e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 5 : 1))}
      onPointerDown={(e) => {
        onActivate();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        onWindow(dy * 2, dx * 4);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved || !rect.w) return;
        const b = box.current!.getBoundingClientRect();
        const fx = (e.clientX - b.left - rect.x) / rect.w;
        const fy = (e.clientY - b.top - rect.y) / rect.h;
        if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) onPoint(fx, fy);
      }}
      onDoubleClick={onReset}
      className={cn(
        "relative min-h-0 min-w-0 cursor-crosshair touch-none select-none overflow-hidden bg-black outline-none",
        active ? "ring-1 ring-inset ring-accent" : "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      )}
    >
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="pointer-events-none absolute [image-rendering:auto]"
          // Dynamic geometry: the image rect inside the pane.
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        />
      )}
      {src && (
        <div className="pointer-events-none absolute" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          <span className="absolute inset-y-0 w-px bg-accent/60" style={{ left: `${cx * 100}%` }} />
          <span className="absolute inset-x-0 h-px bg-accent/60" style={{ top: `${cy * 100}%` }} />
        </div>
      )}
      {!src && !failed && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner label={`Rendering ${label.toLowerCase()}`} />
        </div>
      )}
      {failed && !src && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-white/60">
          This plane could not be rendered.
        </div>
      )}
      <div className="pointer-events-none absolute left-2 top-2 text-xs font-medium text-white/80">{label}</div>
      <div className="pointer-events-none absolute bottom-2 left-2 text-[11px] tabular-nums text-white/60">
        {at[plane] + 1} / {depthOf(info, plane)}
      </div>
    </div>
  );
}

export function NativeMprView({ series, onExit, onUnsupported, onVolumeReady }: Props) {
  const [info, setInfo] = useState<VolumeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<Record<Plane, number>>({ axial: 0, coronal: 0, sagittal: 0 });
  const [voi, setVoi] = useState<{ center: number; width: number }>({ center: 40, width: 400 });
  const [active, setActive] = useState<Plane>("axial");
  const fileIds = useMemo(() => series.headers.map((h) => h.fileId), [series]);

  const reset = useCallback((v: VolumeInfo) => {
    setAt({ axial: Math.floor(v.dims[2] / 2), coronal: Math.floor(v.dims[1] / 2), sagittal: Math.floor(v.dims[0] / 2) });
    const h = series.headers[Math.floor(series.headers.length / 2)];
    if (h?.windowWidth && h.windowWidth > 1 && h.windowCenter != null) setVoi({ center: h.windowCenter, width: h.windowWidth });
    else if (v.window) setVoi({ center: v.window[0], width: v.window[1] });
    else setVoi({ center: (v.min + v.max) / 2, width: Math.max(1, v.max - v.min) });
  }, [series]);

  useEffect(() => {
    let live = true;
    const started = performance.now();
    setInfo(null);
    setError(null);
    invoke<VolumeInfo>("volume_build", { fileIds })
      .then((v) => {
        if (!live) return;
        reset(v);
        setInfo(v);
        onVolumeReady?.({ shellMs: v.buildMs, loadedMs: performance.now() - started });
      })
      .catch((e) => {
        if (!live) return;
        if (/Unsupported TransferSyntax/i.test(String(e)) && onUnsupported) onUnsupported();
        else setError(String(e));
      });
    return () => {
      live = false;
      void invoke("volume_close").catch(() => undefined);
    };
    // onVolumeReady is a bench hook; the volume depends on the files only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIds, reset]);

  const scroll = (plane: Plane, delta: number) =>
    info && setAt((a) => ({ ...a, [plane]: Math.max(0, Math.min(depthOf(info, plane) - 1, a[plane] + delta)) }));

  const point = (plane: Plane, fx: number, fy: number) => {
    if (!info) return;
    const [nx, ny, nz] = info.dims;
    const z = Math.max(0, Math.min(nz - 1, Math.round((1 - fy) * nz - 0.5)));
    setAt((a) =>
      plane === "axial"
        ? { ...a, sagittal: Math.floor(fx * nx), coronal: Math.floor(fy * ny) }
        : plane === "coronal"
          ? { ...a, sagittal: Math.floor(fx * nx), axial: z }
          : { ...a, coronal: Math.floor(fx * ny), axial: z }
    );
  };

  return (
    <section aria-label="MPR" className="flex min-w-0 flex-1 flex-col bg-black">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle bg-surface px-2 text-sm">
        <Button size="sm" variant="ghost" onClick={onExit} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
          Back to 2D
        </Button>
        <span className="font-medium text-primary">MPR</span>
        {info && (
          <span className="tabular-nums text-muted">
            W {Math.round(voi.width)} · L {Math.round(voi.center)} · {info.dims[0]}×{info.dims[1]}×{info.dims[2]}
          </span>
        )}
        <span className="flex-1" />
        {info && (
          <Button size="sm" variant="ghost" onClick={() => reset(info)} leadingIcon={<RotateCcw className="h-4 w-4" />}>
            Reset
          </Button>
        )}
      </header>
      {error ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-white/70">
          <p>This series couldn&apos;t be reconstructed: {error}</p>
          <Button size="sm" variant="secondary" onClick={onExit}>
            Back to 2D
          </Button>
        </div>
      ) : !info ? (
        <div aria-busy="true" className="flex flex-1 items-center justify-center">
          <Spinner label={`Building the volume (${fileIds.length.toLocaleString()} images)`} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-px bg-black">
          {PLANES.map(({ plane, label }) => (
            <Pane
              key={plane}
              info={info}
              plane={plane}
              label={label}
              at={at}
              center={voi.center}
              width={voi.width}
              active={active === plane}
              onActivate={() => setActive(plane)}
              onScroll={(d) => scroll(plane, d)}
              onWindow={(dc, dw) => setVoi((v) => ({ center: v.center + dc, width: Math.max(1, v.width + dw) }))}
              onPoint={(fx, fy) => point(plane, fx, fy)}
              onReset={() => reset(info)}
            />
          ))}
          <div className="flex items-center justify-center p-4 text-center text-xs text-white/50">
            Scroll to move through a plane · drag to window · click to move the crosshair
          </div>
        </div>
      )}
    </section>
  );
}
