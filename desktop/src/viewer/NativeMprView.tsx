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
import { Slider } from "@/components/ui/Slider";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { invoke, volumePlaneUrl } from "../platform";
import type { ViewerSeries } from "../types";
import { installToolCursors } from "./toolCursor";

installToolCursors();

export type Plane = "axial" | "coronal" | "sagittal";

export type SlabMode = "off" | "mip" | "minip" | "avg";
export interface Slab {
  mode: SlabMode;
  /** Thickness in mm (0 = a single slice). */
  mm: number;
}
export const SLAB_MODES: { mode: SlabMode; label: string }[] = [
  { mode: "off", label: "Slice" },
  { mode: "mip", label: "MIP" },
  { mode: "minip", label: "MinIP" },
  { mode: "avg", label: "AvgIP" },
];
export const SLAB_MAX_MM = 100;
export function slabLabel(s: Slab): string | null {
  if (s.mode === "off" || s.mm <= 0) return null;
  return `${SLAB_MODES.find((m) => m.mode === s.mode)?.label} ${s.mm.toFixed(s.mm < 10 ? 1 : 0)} mm`;
}

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
  /** [in-plane, slice] reduction to fit the memory budget (1 = full resolution). */
  reduced: [number, number];
}

/** "Reduced resolution …" note for a volume built under the memory budget, or null. */
export function reducedNote(v: VolumeInfo): string | null {
  const [xy, z] = v.reduced ?? [1, 1];
  if (xy === 1 && z === 1) return null;
  const parts = [xy > 1 ? `${xy}× in-plane` : null, z > 1 ? `${z} slices averaged` : null].filter(Boolean);
  return `Reduced resolution to fit memory (${parts.join(", ")})`;
}

interface Props {
  series: ViewerSeries;
  onExit: () => void;
  /** The native core cannot read this series (e.g. JPEG-LS): use the GPU MPR. */
  onUnsupported?: () => void;
  onVolumeReady?: (t: { shellMs: number; loadedMs: number }) => void;
  /** Start with a slab (bench / shortcut); default a single slice. */
  initialSlab?: Slab;
  /** Bench: every pane has drawn its first plane (brightest pixel per pane). */
  onPainted?: (t: { ms: number; maxLum: Record<string, number> }) => void;
}

const PLANES: { plane: Plane; label: string }[] = [
  { plane: "axial", label: "Axial" },
  { plane: "sagittal", label: "Sagittal" },
  { plane: "coronal", label: "Coronal" },
];

/** Slice count along a plane's own axis. */
export function depthOf(info: VolumeInfo, plane: Plane): number {
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

/** Brightest pixel of a decoded image (0–255): the "is anything drawn" check. */
function maxLuminance(img: HTMLImageElement): number {
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return -1;
  let d: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, 48, 48);
    d = ctx.getImageData(0, 0, 48, 48).data;
  } catch {
    return -1; // tainted canvas: unknown, not blank
  }
  let max = 0;
  for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i]);
  return max;
}

/**
 * Latest-wins image loading: no flicker, never a queue of stale planes. A
 * failed plane (the volume is being rebuilt) is retried, 3 times, backing off.
 */
export function usePlaneImage(url: string | null, onLoaded?: (maxLum: number) => void): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const wanted = useRef<string | null>(null);
  const tries = useRef(0);
  const loadedCb = useRef(onLoaded);
  loadedCb.current = onLoaded;
  const load = useCallback(() => {
    const next = wanted.current;
    if (!next || busy.current) return;
    busy.current = true;
    const img = new Image();
    img.decoding = "async";
    // The protocol answers with Access-Control-Allow-Origin: *; anonymous CORS
    // keeps the pixels readable for the paint check.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      busy.current = false;
      tries.current = 0;
      setSrc(next);
      setFailed(false);
      loadedCb.current?.(maxLuminance(img));
      if (wanted.current !== next) load();
    };
    img.onerror = () => {
      busy.current = false;
      if (wanted.current !== next) return load();
      if (tries.current < 3) {
        tries.current += 1;
        window.setTimeout(load, 150 * tries.current);
      } else setFailed(true);
    };
    img.src = next;
  }, []);
  useEffect(() => {
    wanted.current = url;
    tries.current = 0;
    load();
  }, [url, load]);
  return { src, failed };
}

export function Pane({
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
  onPainted,
  slab,
  onSlab,
  crosshair: showCrosshair = true,
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
  onPainted?: (maxLum: number) => void;
  slab: Slab;
  /** Change the slab thickness by `deltaMm` (Ctrl+wheel). */
  onSlab: (deltaMm: number) => void;
  /** Draw the crosshair (MPR); a single-plane reformat hides it. */
  crosshair?: boolean;
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
  const url = scale ? volumePlaneUrl(info.key, plane, at[plane], center, width, maxDim, slab) : null;
  const slabText = slabLabel(slab);
  const { src, failed } = usePlaneImage(url, onPainted);
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
      onWheel={(e) => {
        // Ctrl+wheel: slab thickness (Shift: ×5); plain wheel pages the slab.
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onSlab((e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 5 : 1));
        } else onScroll((e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 5 : 1));
      }}
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
        // Click places the crosshair; without one, drag only windows.
        showCrosshair ? "cursor-crosshair" : "tool-cursor-wl",
        "relative min-h-0 min-w-0 touch-none select-none overflow-hidden bg-black outline-none",
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
      {src && showCrosshair && (
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
      {slabText && (
        <div data-testid="slab-overlay" className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-accent">
          {slabText}
        </div>
      )}
    </div>
  );
}

export function NativeMprView({ series, onExit, onUnsupported, onVolumeReady, onPainted, initialSlab }: Props) {
  const [info, setInfo] = useState<VolumeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<Record<Plane, number>>({ axial: 0, coronal: 0, sagittal: 0 });
  const [voi, setVoi] = useState<{ center: number; width: number }>({ center: 40, width: 400 });
  const [active, setActive] = useState<Plane>("axial");
  const [slab, setSlab] = useState<Slab>(initialSlab ?? { mode: "off", mm: 0 });
  const changeSlab = (deltaMm: number) =>
    setSlab((s) => {
      const mm = Math.max(0, Math.min(SLAB_MAX_MM, s.mm + deltaMm));
      // Thickening from a single slice starts a MIP (RadiAnt's default).
      return { mode: mm === 0 ? "off" : s.mode === "off" ? "mip" : s.mode, mm };
    });
  const pickSlabMode = (mode: SlabMode) => setSlab((s) => ({ mode, mm: mode === "off" ? 0 : s.mm || 10 }));
  // Keyed on the SET of files, not the series object: a cold open rebuilds the
  // study list (new objects, same files) and must not rebuild the volume.
  const filesKey = useMemo(() => series.headers.map((h) => h.fileId).sort((a, b) => a - b).join(","), [series]);
  const fileIds = useMemo(() => (filesKey ? filesKey.split(",").map(Number) : []), [filesKey]);
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const opened = useRef(0);
  const painted = useRef<Record<string, number>>({});
  const paintedCb = useRef(onPainted);
  paintedCb.current = onPainted;
  const readyCb = useRef(onVolumeReady);
  readyCb.current = onVolumeReady;
  const notePaint = (plane: Plane, lum: number) => {
    if (plane in painted.current) return;
    painted.current[plane] = lum;
    if (Object.keys(painted.current).length === 3) {
      paintedCb.current?.({ ms: performance.now() - opened.current, maxLum: { ...painted.current } });
    }
  };

  const reset = useCallback((v: VolumeInfo) => {
    setAt({ axial: Math.floor(v.dims[2] / 2), coronal: Math.floor(v.dims[1] / 2), sagittal: Math.floor(v.dims[0] / 2) });
    const headers = seriesRef.current.headers;
    const h = headers[Math.floor(headers.length / 2)];
    if (h?.windowWidth && h.windowWidth > 1 && h.windowCenter != null) setVoi({ center: h.windowCenter, width: h.windowWidth });
    else if (v.window) setVoi({ center: v.window[0], width: v.window[1] });
    else setVoi({ center: (v.min + v.max) / 2, width: Math.max(1, v.max - v.min) });
  }, []);

  useEffect(() => {
    let live = true;
    let key: string | null = null;
    const started = performance.now();
    opened.current = started;
    painted.current = {};
    setInfo(null);
    setError(null);
    invoke<VolumeInfo>("volume_build", { fileIds })
      .then((v) => {
        key = v.key;
        if (!live) {
          // Unmounted while building: hand the volume back.
          void invoke("volume_close", { key }).catch(() => undefined);
          return;
        }
        reset(v);
        setInfo(v);
        readyCb.current?.({ shellMs: v.buildMs, loadedMs: performance.now() - started });
      })
      .catch((e) => {
        if (!live) return;
        if (/Unsupported TransferSyntax/i.test(String(e)) && onUnsupported) onUnsupported();
        else setError(String(e));
      });
    return () => {
      live = false;
      if (key) void invoke("volume_close", { key }).catch(() => undefined);
    };
    // The volume depends on the set of files only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey, reset]);

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
        {info && (
          <div role="radiogroup" aria-label="Slab" className="ml-2 flex items-center gap-1">
            {SLAB_MODES.map((m) => (
              <Button
                key={m.mode}
                size="sm"
                variant={slab.mode === m.mode ? "secondary" : "ghost"}
                role="radio"
                aria-checked={slab.mode === m.mode}
                onClick={() => pickSlabMode(m.mode)}
              >
                {m.label}
              </Button>
            ))}
            {slab.mode !== "off" && (
              <Slider
                label="Thickness"
                min={1}
                max={SLAB_MAX_MM}
                value={slab.mm}
                valueLabel={`${slab.mm} mm`}
                onChange={(mm) => setSlab((s) => ({ ...s, mm }))}
                className="ml-2 w-40"
              />
            )}
          </div>
        )}
        {info && reducedNote(info) && <span className="text-xs text-warning">{reducedNote(info)}</span>}
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
              onPainted={(lum) => notePaint(plane, lum)}
              slab={slab}
              onSlab={changeSlab}
            />
          ))}
          <div className="flex items-center justify-center p-4 text-center text-xs text-white/50">
            Scroll to move through a plane · Ctrl+scroll for slab thickness · drag to window · click to move the crosshair
          </div>
        </div>
      )}
    </section>
  );
}
