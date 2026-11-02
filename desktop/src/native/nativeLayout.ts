// Phase 2, P2.2: the native renderer draws every layout cell in one frame, so
// it wants every cell's rectangle at once. Mounted native viewports register
// their element here; changes (resize, layout switch, scroll of the page) are
// batched to one `native_layout` call per animation frame.

import { invoke } from "../platform";

const cells = new Map<string, HTMLElement>();
let scheduled = 0;
const applied = new Set<() => void>();

let lastSent = "";

function flush() {
  scheduled = 0;
  const rects = [...cells.entries()].map(([id, el]) => {
    const r = el.getBoundingClientRect();
    return { id, x: r.left, y: r.top, w: r.width, h: r.height };
  });
  // The position check below runs often: send only what changed.
  const sig = JSON.stringify(rects);
  if (sig === lastSent) return;
  lastSent = sig;
  void invoke("native_layout", { cells: rects }).then(
    () => applied.forEach((fn) => fn()),
    () => {
      lastSent = "";
    }
  );
}

/**
 * A ResizeObserver sees size changes only. A cell that MOVES without
 * resizing (an MPR plane re-centred in its pane, the series panel or toolbar
 * sliding in, a grid reflow) kept its old position in Rust, so the coronal /
 * sagittal planes drew off their panes over the axial pane's border (HP
 * 0.8.1). While native cells exist, positions are re-checked a few times a
 * second and after any CSS transition; an unchanged layout costs one
 * getBoundingClientRect per cell and no IPC.
 */
const POSITION_CHECK_MS = 200;
let positionTimer = 0;
function watchPositions(on: boolean) {
  if (typeof window === "undefined") return;
  if (on && !positionTimer) positionTimer = window.setInterval(scheduleNativeLayout, POSITION_CHECK_MS);
  if (!on && positionTimer) {
    window.clearInterval(positionTimer);
    positionTimer = 0;
  }
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
  // The container too: a plane surface is positioned inside its pane, and the
  // pane resizing moves it without resizing it.
  if (el.parentElement) observer.observe(el.parentElement);
  watchPositions(true);
  scheduleNativeLayout();
  return () => {
    observer.disconnect();
    if (cells.get(id) === el) cells.delete(id);
    if (cells.size === 0) watchPositions(false);
    void invoke("native_cell_close", { id }).catch(() => undefined);
    scheduleNativeLayout();
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", scheduleNativeLayout);
  // Panels that slide (series panel collapse) move cells without resizing them.
  window.addEventListener("transitionend", scheduleNativeLayout, true);
}

/** Native mode is on (FLOWRAD_NATIVE=1, Tauri only); cached after the first ask. */
let nativeOn: Promise<boolean> | null = null;
export function nativeEnabled(): Promise<boolean> {
  nativeOn ??= invoke<{ enabled: boolean; ready: boolean }>("native_init")
    .then((s) => !!s.enabled && !!s.ready)
    .catch(() => false);
  return nativeOn;
}

/** React: true once native mode is confirmed (false on the web and until then). */
import { useEffect as useEffectR, useState as useStateR } from "react";
export function useNativeMode(): boolean {
  const [on, setOn] = useStateR(false);
  useEffectR(() => {
    let live = true;
    void nativeEnabled().then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
