// Phase 2, P2.5: the 3D view's frame drawn by the native renderer. Rust
// ray-casts the shared volume on every core (render3d.rs, unchanged) and the
// frame goes straight into an RGBA texture under the page, instead of a PNG
// the browser decodes and re-uploads in WebView2's GPU process. Latest wins:
// one frame in flight, a drag skips straight to the newest view.

import { useEffect, useRef } from "react";
import { invoke } from "../platform";
import { registerNativeCell } from "./nativeLayout";

interface Props {
  volumeKey: string;
  mode: string;
  view: { yaw: number; pitch: number; zoom: number };
  center: number;
  width: number;
  size: number;
  /** Device pixels of the frame's long side. */
  px: number;
  fast: boolean;
  onPainted?: (maxLum: number, fast: boolean) => void;
  onError?: (message: string) => void;
}

export default function NativeRender3DSurface({ volumeKey, mode, view, center, width, size, px, fast, onPainted, onError }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const id = useRef(`3d:${Math.random().toString(36).slice(2, 8)}`).current;
  const cb = useRef({ onPainted, onError });
  cb.current = { onPainted, onError };
  useEffect(() => {
    if (!el.current) return;
    return registerNativeCell(id, el.current);
  }, [id]);
  const pending = useRef<Record<string, unknown> | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    pending.current = { id, key: volumeKey, mode, yaw: view.yaw, pitch: view.pitch, zoom: view.zoom, center, width, size: px, fast };
    const pump = async () => {
      if (busy.current || !pending.current) return;
      const args = pending.current;
      pending.current = null;
      busy.current = true;
      try {
        const r = await invoke<{ maxLum: number }>("native_cell_render3d", args);
        cb.current.onPainted?.(r.maxLum, args.fast as boolean);
      } catch (e) {
        cb.current.onError?.(String(e));
      } finally {
        busy.current = false;
        if (pending.current) void pump();
      }
    };
    void pump();
  }, [id, volumeKey, mode, view.yaw, view.pitch, view.zoom, center, width, px, fast]);
  return (
    <div
      ref={el}
      data-native-3d
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      // Dynamic geometry: a square frame fitted to the pane.
      style={{ width: size, height: size }}
    />
  );
}
