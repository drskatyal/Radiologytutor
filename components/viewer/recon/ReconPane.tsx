"use client";

// One reconstruction pane: samples its grid (latest request wins), windows the
// values onto a canvas, and reports pointer / wheel input in GRID pixels so
// the workspace can map them to patient space. Overlays (crosshairs, curve,
// labels) are children drawn in the same grid pixel space via an SVG viewBox.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { windowToRgba, type ReconImage, type SampleGrid } from "@flowrad/viewer-core/recon";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import type { ReconSource } from "./types";

export interface PanePointer {
  x: number;
  y: number;
  button: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  detail: number;
}

/** Largest grid sampled for a pane (pixels per side). */
export const PANE_MAX_PX = 768;

export function usePaneSize(): [(el: HTMLDivElement | null) => void, { width: number; height: number } | null] {
  // A callback ref: panes that mount later (switching to Curved) are measured too.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      const k = Math.min(1, PANE_MAX_PX / Math.max(r.width, r.height));
      const width = Math.max(32, Math.round(r.width * k));
      const height = Math.max(32, Math.round(r.height * k));
      setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

/** Sample `grid` whenever it changes; stale requests are aborted. */
export function useReconImage(source: ReconSource, grid: SampleGrid | null, channel: string) {
  const [state, setState] = useState<{ image: ReconImage | null; busy: boolean; error: string | null; ms: number | null }>({
    image: null,
    busy: false,
    error: null,
    ms: null,
  });
  useEffect(() => {
    if (!grid) return;
    const ctl = new AbortController();
    const t0 = performance.now();
    setState((s) => ({ ...s, busy: true }));
    source.sample(grid, channel, ctl.signal).then(
      (image) => {
        if (!ctl.signal.aborted) setState({ image, busy: false, error: null, ms: performance.now() - t0 });
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        const name = (e as { name?: string })?.name;
        if (name === "ReconCancelled" || /superseded/i.test(String((e as Error)?.message ?? e))) return;
        setState((s) => ({ ...s, busy: false, error: e instanceof Error ? e.message : String(e) }));
      }
    );
    return () => ctl.abort();
  }, [source, grid, channel]);
  return state;
}

export function ReconPane({
  image,
  busy,
  error,
  ww,
  wc,
  invert,
  label,
  className,
  cursor,
  active,
  onPointer,
  onWheel,
  onFocus,
  children,
  canvasRef,
}: {
  image: ReconImage | null;
  busy: boolean;
  error: string | null;
  ww: number;
  wc: number;
  invert?: boolean;
  label: string;
  className?: string;
  cursor?: string;
  active?: boolean;
  onPointer?: (phase: "down" | "move" | "up", p: PanePointer, e: React.PointerEvent) => void;
  onWheel?: (deltaY: number, e: { shift: boolean; mod: boolean }) => void;
  onFocus?: () => void;
  children?: ReactNode;
  canvasRef?: React.RefObject<HTMLCanvasElement>;
}) {
  const own = useRef<HTMLCanvasElement>(null);
  const canvas = canvasRef ?? own;
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !image) return;
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext("2d");
    ctx?.putImageData(new ImageData(windowToRgba(image, ww, wc, invert), image.width, image.height), 0, 0);
  }, [canvas, image, ww, wc, invert]);

  // Wheel must be non-passive to stop the page scrolling.
  useEffect(() => {
    const el = wrap.current;
    if (!el || !onWheel) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      onWheel(e.deltaY, { shift: e.shiftKey, mod: e.ctrlKey || e.metaKey });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [onWheel]);

  const toGrid = (e: React.PointerEvent): PanePointer => {
    const r = wrap.current!.getBoundingClientRect();
    const w = image?.width ?? r.width;
    const h = image?.height ?? r.height;
    return {
      x: ((e.clientX - r.left) / r.width) * w - 0.5,
      y: ((e.clientY - r.top) / r.height) * h - 0.5,
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: e.ctrlKey || e.metaKey,
      detail: e.detail,
    };
  };

  return (
    <div
      ref={wrap}
      role="img"
      aria-label={label}
      tabIndex={onPointer ? 0 : undefined}
      onFocus={onFocus}
      className={cn("relative h-full w-full touch-none select-none overflow-hidden bg-imaging outline-none", active && "ring-1 ring-inset ring-accent/70", className)}
      style={cursor ? { cursor } : undefined}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        onFocus?.();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onPointer?.("down", toGrid(e), e);
      }}
      onPointerMove={(e) => onPointer?.("move", toGrid(e), e)}
      onPointerUp={(e) => {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        onPointer?.("up", toGrid(e), e);
      }}
    >
      {/* Grid pixels are square millimetres, so stretching to the box keeps the aspect. */}
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      {image && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          viewBox={`-0.5 -0.5 ${image.width} ${image.height}`}
          preserveAspectRatio="none"
        >
          {children}
        </svg>
      )}
      {busy && !image && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size="sm" label="Reconstructing" />
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-x-3 top-1/2 -translate-y-1/2 rounded-lg bg-black/80 p-2 text-center text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  );
}
