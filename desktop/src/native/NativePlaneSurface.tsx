// Phase 2, P2.4: a plane (or slab) of the Rust volume drawn by the native
// renderer inside an MPR / reformat pane, in place of the PNG <img> the JS
// path loads. Rust resamples the plane from the shared volume as modality
// values and the GPU applies window / level: no PNG encode, no browser decode,
// no copy in WebView2's GPU process. The element is a transparent hole sized
// to the image rect, so the pane's crosshair and labels sit on top as before.

import { useEffect, useRef } from "react";
import { invoke } from "../platform";
import { registerNativeCell, scheduleNativeLayout } from "./nativeLayout";

interface Props {
  id: string;
  volumeKey: string;
  plane: "axial" | "coronal" | "sagittal";
  index: number;
  slab: { mode: "off" | "mip" | "minip" | "avg"; mm: number };
  center: number;
  width: number;
  maxDim: number;
  rect: { x: number; y: number; w: number; h: number };
  /** Called after each paint with the brightest grey drawn (0–255). */
  onPainted?: (maxLum: number) => void;
  onError?: (message: string) => void;
}

export default function NativePlaneSurface({ id, volumeKey, plane, index, slab, center, width, maxDim, rect, onPainted, onError }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const painted = useRef(onPainted);
  painted.current = onPainted;
  useEffect(() => {
    if (!el.current) return;
    return registerNativeCell(id, el.current);
  }, [id]);
  // The image rect moves inside the pane (re-centred when the pane's aspect
  // changes) often without changing size, which a ResizeObserver misses.
  useEffect(() => {
    scheduleNativeLayout();
  }, [rect.x, rect.y, rect.w, rect.h]);
  // Latest wins: one call in flight, the newest arguments next.
  const pending = useRef<Record<string, unknown> | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    pending.current = {
      id,
      key: volumeKey,
      plane,
      index,
      slab: slab.mode,
      mm: slab.mm,
      maxDim,
      wl: [center, width],
    };
    const pump = async () => {
      if (busy.current || !pending.current) return;
      const args = pending.current;
      pending.current = null;
      busy.current = true;
      try {
        const r = await invoke<{ dataMax: number; window: [number, number] }>("native_cell_plane", args);
        const [c, w] = r.window;
        painted.current?.(Math.round(Math.max(0, Math.min(1, (r.dataMax - (c - w / 2)) / Math.max(w, 1))) * 255));
      } catch (e) {
        onError?.(String(e));
      } finally {
        busy.current = false;
        if (pending.current) void pump();
      }
    };
    void pump();
  }, [id, volumeKey, plane, index, slab.mode, slab.mm, center, width, maxDim, onError]);
  return (
    <div
      ref={el}
      data-native-plane={plane}
      aria-hidden
      className="pointer-events-none absolute"
      // Dynamic geometry: the image rect inside the pane.
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    />
  );
}
