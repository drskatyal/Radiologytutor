// Series drag-and-drop with pointer events.
//
// HTML5 drag-and-drop never reaches the page on Windows while Tauri's native
// file drop is enabled (it is: folders dropped from Explorer open a study), so
// dragging a series card onto a viewport did nothing on the HP. This drives
// the whole gesture from pointer events instead: a card starts a drag after the
// pointer moves a few pixels, a ghost label follows the cursor, the viewport
// under it lights up, and releasing over it shows the series there.
//
// Viewports opt in with `data-drop-cell="<index>"` on their root element.

import { useSyncExternalStore } from "react";

export interface SeriesDrag {
  uid: string;
  label: string;
  x: number;
  y: number;
  /** Cell index under the pointer, if any. */
  cell: number | null;
}

let current: SeriesDrag | null = null;
const listeners = new Set<() => void>();
let dropHandler: ((uid: string, cell: number) => void) | null = null;

function emit() {
  listeners.forEach((l) => l());
}

export function onSeriesDrop(handler: ((uid: string, cell: number) => void) | null): void {
  dropHandler = handler;
}

export function useSeriesDrag(): SeriesDrag | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null
  );
}

function cellAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)?.closest("[data-drop-cell]");
  const v = el?.getAttribute("data-drop-cell");
  return v == null ? null : Number(v);
}

/** Pixels the pointer must travel before a press on a card becomes a drag. */
export const DRAG_THRESHOLD = 6;

/**
 * Wire on a series card's onPointerDown. Returns true from `wasDrag()` after
 * the gesture so the card's click (open in the active viewport) can be skipped.
 */
export function beginSeriesPointer(e: React.PointerEvent, uid: string, label: string): { wasDrag: () => boolean } {
  let dragged = false;
  if (e.button !== 0) return { wasDrag: () => false };
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => {
    if (!dragged && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
    dragged = true;
    current = { uid, label, x: ev.clientX, y: ev.clientY, cell: cellAt(ev.clientX, ev.clientY) };
    emit();
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    if (dragged) {
      const cell = cellAt(ev.clientX, ev.clientY);
      current = null;
      emit();
      if (cell != null) dropHandler?.(uid, cell);
    }
  };
  const cancel = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    current = null;
    emit();
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  return { wasDrag: () => dragged };
}
