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
//
// Monitor picker (RadiAnt-style): with two or more monitors, holding a card
// (~300 ms) or starting to drag it shows one numbered, coloured tile per
// monitor over the card, laid out like the desk. Releasing on a tile opens the
// series on that monitor; releasing anywhere else is the normal drop; Esc
// cancels. The monitor list is read at every press, so hot-plugged screens
// show up.

import { useSyncExternalStore } from "react";
import { monitorTiles, tileAt, type MonitorInfo, type MonitorTile } from "@flowrad/viewer-core";

export interface MonitorPickerState {
  /** Picker box in viewport coordinates (over the card). */
  left: number;
  top: number;
  width: number;
  height: number;
  tiles: MonitorTile[];
  /** Name of the tile under the pointer. */
  hover: string | null;
}

export interface SeriesDrag {
  uid: string;
  label: string;
  x: number;
  y: number;
  /** Cell index under the pointer, if any. */
  cell: number | null;
  picker?: MonitorPickerState | null;
}

let current: SeriesDrag | null = null;
const listeners = new Set<() => void>();
let dropHandler: ((uid: string, cell: number) => void) | null = null;
let monitorHandler: ((uid: string, monitorName: string) => void) | null = null;
let monitorSource: (() => Promise<MonitorInfo[]>) | null = null;

/** Height of the picker's caption row ("Open on monitor 2"). */
export const PICKER_CAPTION = 20;

/** Hold time before the monitor picker appears without moving. */
export const PICKER_HOLD_MS = 300;

/** Where the picker gets the monitors (desktop: the Rust shell). None: no picker. */
export function setMonitorSource(source: (() => Promise<MonitorInfo[]>) | null): void {
  monitorSource = source;
}

/** Called when a series is released on a monitor tile. */
export function onSeriesToMonitor(handler: ((uid: string, monitorName: string) => void) | null): void {
  monitorHandler = handler;
}

/** The picker box over a card: the card's own box, grown to stay legible. */
export function pickerBox(card: { left: number; top: number; width: number; height: number }, monitors: readonly MonitorInfo[]): MonitorPickerState {
  const width = Math.max(card.width, 176);
  const height = Math.max(card.height, 120);
  const left = Math.max(4, card.left + card.width / 2 - width / 2);
  const top = Math.max(4, card.top + card.height / 2 - height / 2);
  // Tiles above a caption row (PICKER_CAPTION px) inside the box.
  const tiles = monitorTiles(monitors, { width: width - 12, height: height - 12 - PICKER_CAPTION }, 6).map((t) => ({ ...t, left: t.left + 6, top: t.top + 6 }));
  return { left, top, width, height, tiles, hover: null };
}

function pickerHover(p: MonitorPickerState, x: number, y: number): string | null {
  return tileAt(p.tiles, x - p.left, y - p.top)?.name ?? null;
}
export function insidePicker(p: MonitorPickerState, x: number, y: number): boolean {
  return x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height;
}

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
  let x = x0;
  let y = y0;
  const card = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // Fresh every press: a monitor plugged in or removed since shows (or not).
  let monitors: MonitorInfo[] = [];
  let picker: MonitorPickerState | null = null;
  void monitorSource?.().then((m) => {
    monitors = m;
  });
  const showPicker = () => {
    if (picker || monitors.length < 2 || !monitorHandler) return;
    picker = pickerBox(card, monitors);
    picker.hover = pickerHover(picker, x, y);
    dragged = true;
    current = { uid, label, x, y, cell: null, picker };
    emit();
  };
  const hold = window.setTimeout(showPicker, PICKER_HOLD_MS);
  const move = (ev: PointerEvent) => {
    x = ev.clientX;
    y = ev.clientY;
    if (!dragged && Math.hypot(x - x0, y - y0) < DRAG_THRESHOLD) return;
    dragged = true;
    showPicker();
    if (picker) picker = { ...picker, hover: pickerHover(picker, x, y) };
    current = { uid, label, x, y, cell: picker && insidePicker(picker, x, y) ? null : cellAt(x, y), picker };
    emit();
  };
  const finish = () => {
    window.clearTimeout(hold);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", onKey, true);
    current = null;
    emit();
  };
  const up = (ev: PointerEvent) => {
    const tile = picker ? pickerHover(picker, ev.clientX, ev.clientY) : null;
    const overPicker = picker ? insidePicker(picker, ev.clientX, ev.clientY) : false;
    const cell = dragged && !overPicker ? cellAt(ev.clientX, ev.clientY) : null;
    finish();
    if (tile) monitorHandler?.(uid, tile);
    else if (cell != null) dropHandler?.(uid, cell);
  };
  const cancel = () => {
    dragged = true;
    finish();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", onKey, true);
  return { wasDrag: () => dragged };
}
