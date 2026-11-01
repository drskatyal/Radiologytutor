// Native 3D: volume rendering and MIP ray-cast in Rust (render3d.rs) from the
// same shared 16-bit volume as the native MPR. The webview shows one PNG per
// frame: never a JS volume or a GPU volume texture (HP, 0.6.0: the old 3D view
// was blank, peaked at 3.4 GB and froze for 1.19 s).
//
// Drag rotates (fast frames from a half-resolution copy, then a full-quality
// frame when the drag ends), the wheel zooms, Shift+drag windows the MIP,
// double-click resets. Presets: Bone, Soft tissue, MIP.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { invoke, render3dUrl } from "../platform";
import type { ViewerSeries } from "../types";
import { reducedNote, usePlaneImage, type VolumeInfo } from "./NativeMprView";

type Mode = "bone" | "soft" | "mip";

const MODES: { mode: Mode; label: string }[] = [
  { mode: "bone", label: "Bone" },
  { mode: "soft", label: "Soft tissue" },
  { mode: "mip", label: "MIP" },
];

interface Props {
  series: ViewerSeries;
  onExit: () => void;
  onUnsupported?: () => void;
  onVolumeReady?: (t: { shellMs: number; loadedMs: number }) => void;
  /** Bench: the first frame is on screen (its brightest pixel). */
  onPainted?: (t: { ms: number; maxLum: Record<string, number> }) => void;
}

const DEFAULT_VIEW = { yaw: 0, pitch: 0, zoom: 1 };

export function Native3DView({ series, onExit, onUnsupported, onVolumeReady, onPainted }: Props) {
  const [info, setInfo] = useState<VolumeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(series.modality === "MR" ? "mip" : "bone");
  const [view, setView] = useState(DEFAULT_VIEW);
  const [dragging, setDragging] = useState(false);
  const [voi, setVoi] = useState({ center: 300, width: 1500 });
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);

  const filesKey = useMemo(() => series.headers.map((h) => h.fileId).sort((a, b) => a - b).join(","), [series]);
  const fileIds = useMemo(() => (filesKey ? filesKey.split(",").map(Number) : []), [filesKey]);
  const opened = useRef(0);
  const paintedOnce = useRef(false);
  const cbs = useRef({ onPainted, onVolumeReady, onUnsupported });
  cbs.current = { onPainted, onVolumeReady, onUnsupported };

  useEffect(() => {
    let live = true;
    let key: string | null = null;
    const started = performance.now();
    opened.current = started;
    paintedOnce.current = false;
    setInfo(null);
    setError(null);
    invoke<VolumeInfo>("volume_build", { fileIds })
      .then((v) => {
        key = v.key;
        if (!live) return void invoke("volume_close", { key }).catch(() => undefined);
        if (v.window && mode === "mip") setVoi({ center: v.window[0], width: v.window[1] });
        setInfo(v);
        cbs.current.onVolumeReady?.({ shellMs: v.buildMs, loadedMs: performance.now() - started });
      })
      .catch((e) => {
        if (!live) return;
        if (/Unsupported TransferSyntax/i.test(String(e)) && cbs.current.onUnsupported) cbs.current.onUnsupported();
        else setError(String(e));
      });
    return () => {
      live = false;
      if (key) void invoke("volume_close", { key }).catch(() => undefined);
    };
    // The volume depends on the set of files only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(Math.min(el.clientWidth, el.clientHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [info]);

  const dpr = window.devicePixelRatio || 1;
  // Interactive frames at ~half the device pixels, final frames at full (capped).
  const px = Math.min(1024, Math.max(128, Math.round(size * dpr * (dragging ? 0.5 : 1))));
  const url = info && size ? render3dUrl(info.key, mode, view, voi.center, voi.width, px, dragging) : null;
  const { src, failed } = usePlaneImage(url, (lum) => {
    if (paintedOnce.current || dragging) return;
    paintedOnce.current = true;
    cbs.current.onPainted?.({ ms: performance.now() - opened.current, maxLum: { "3d": lum } });
  });

  const drag = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  return (
    <section aria-label="3D" className="flex min-w-0 flex-1 flex-col bg-black">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle bg-surface px-2 text-sm">
        <Button size="sm" variant="ghost" onClick={onExit} leadingIcon={<ArrowLeft className="h-4 w-4" />}>
          Back to 2D
        </Button>
        <span className="font-medium text-primary">3D</span>
        <div role="radiogroup" aria-label="Rendering" className="ml-2 flex gap-1">
          {MODES.map((m) => (
            <Button
              key={m.mode}
              size="sm"
              variant={mode === m.mode ? "secondary" : "ghost"}
              role="radio"
              aria-checked={mode === m.mode}
              onClick={() => setMode(m.mode)}
            >
              {m.label}
            </Button>
          ))}
        </div>
        {mode === "mip" && (
          <span className="tabular-nums text-muted">
            W {Math.round(voi.width)} · L {Math.round(voi.center)}
          </span>
        )}
        {info && reducedNote(info) && <span className="text-xs text-warning">{reducedNote(info)}</span>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setView(DEFAULT_VIEW)} leadingIcon={<RotateCcw className="h-4 w-4" />}>
          Reset
        </Button>
      </header>
      {error ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-white/70">
          <p>This series couldn&apos;t be rendered in 3D: {error}</p>
          <Button size="sm" variant="secondary" onClick={onExit}>
            Back to 2D
          </Button>
        </div>
      ) : !info ? (
        <div aria-busy="true" className="flex flex-1 items-center justify-center">
          <Spinner label={`Building the volume (${fileIds.length.toLocaleString()} images)`} />
        </div>
      ) : (
        <div
          ref={box}
          role="img"
          aria-label={`3D ${MODES.find((m) => m.mode === mode)?.label ?? ""} rendering; drag to rotate`}
          tabIndex={0}
          className={cn(
            "relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-black outline-none",
            "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
            dragging ? "cursor-grabbing" : "cursor-grab"
          )}
          onWheel={(e) => setView((v) => ({ ...v, zoom: Math.min(6, Math.max(0.5, v.zoom * (e.deltaY > 0 ? 0.9 : 1.1))) }))}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            d.x = e.clientX;
            d.y = e.clientY;
            if (d.shift) setVoi((v) => ({ center: v.center + dy * 4, width: Math.max(1, v.width + dx * 8) }));
            else
              setView((v) => ({
                ...v,
                yaw: v.yaw + dx * 0.01,
                pitch: Math.max(-1.5, Math.min(1.5, v.pitch + dy * 0.01)),
              }));
          }}
          onPointerUp={() => {
            drag.current = null;
            setDragging(false);
          }}
          onDoubleClick={() => setView(DEFAULT_VIEW)}
          onKeyDown={(e) => {
            const step = 0.1;
            if (e.key === "ArrowLeft") setView((v) => ({ ...v, yaw: v.yaw - step }));
            else if (e.key === "ArrowRight") setView((v) => ({ ...v, yaw: v.yaw + step }));
            else if (e.key === "ArrowUp") setView((v) => ({ ...v, pitch: Math.max(-1.5, v.pitch - step) }));
            else if (e.key === "ArrowDown") setView((v) => ({ ...v, pitch: Math.min(1.5, v.pitch + step) }));
            else return;
            e.preventDefault();
          }}
        >
          {src && (
            <img
              src={src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              // Dynamic geometry: a square frame fitted to the pane.
              style={{ width: size, height: size }}
            />
          )}
          {!src && !failed && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner label="Rendering" />
            </div>
          )}
          {failed && !src && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60">This view could not be rendered.</div>
          )}
          <div className="pointer-events-none absolute bottom-2 left-2 text-[11px] text-white/50">
            Drag to rotate · wheel to zoom{mode === "mip" ? " · Shift+drag to window" : ""} · double-click to reset
          </div>
        </div>
      )}
    </section>
  );
}
