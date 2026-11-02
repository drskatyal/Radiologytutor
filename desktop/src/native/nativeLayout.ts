// Phase 2, P2.2: the native renderer draws every layout cell in one frame, so
// it wants every cell's rectangle at once. Mounted native viewports register
// their element here; changes (resize, layout switch, scroll of the page) are
// batched to one `native_layout` call per animation frame.

import { invoke } from "../platform";

const cells = new Map<string, HTMLElement>();
let scheduled = 0;
const applied = new Set<() => void>();

function flush() {
  scheduled = 0;
  const rects = [...cells.entries()].map(([id, el]) => {
    const r = el.getBoundingClientRect();
    return { id, x: r.left, y: r.top, w: r.width, h: r.height };
  });
  void invoke("native_layout", { cells: rects }).then(
    () => applied.forEach((fn) => fn()),
    () => undefined
  );
}

/**
 * Called after Rust has applied a new layout. A viewport whose size changed
 * refreshes its view then: the image <-> cell transform Rust returns depends
 * on the cell size (a series shown before its first layout came back with a
 * 0 x 0 cell, so overlays and tools mapped to NaN until the next change).
 */
export function onNativeLayoutApplied(fn: () => void): () => void {
  applied.add(fn);
  return () => applied.delete(fn);
}

export function scheduleNativeLayout(): void {
  if (!scheduled) scheduled = requestAnimationFrame(flush);
}

/** Register a native cell's element; returns the unregister function. */
export function registerNativeCell(id: string, el: HTMLElement): () => void {
  cells.set(id, el);
  const observer = new ResizeObserver(scheduleNativeLayout);
  observer.observe(el);
  scheduleNativeLayout();
  return () => {
    observer.disconnect();
    if (cells.get(id) === el) cells.delete(id);
    void invoke("native_cell_close", { id }).catch(() => undefined);
    scheduleNativeLayout();
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", scheduleNativeLayout);
}

/** Native mode is on (FLOWRAD_NATIVE=1, Tauri only); cached after the first ask. */
let nativeOn: Promise<boolean> | null = null;
export function nativeEnabled(): Promise<boolean> {
  nativeOn ??= invoke<{ enabled: boolean; ready: boolean }>("native_init")
    .then((s) => !!s.enabled && !!s.ready)
    .catch(() => false);
  return nativeOn;
}
