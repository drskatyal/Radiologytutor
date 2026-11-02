// Click vs drag for any mouse button, and capture of "press the button or key
// you want to bind". Pure state machines over event-like objects, so they are
// unit-tested without a DOM.

import { keySpecOf, mouseSpecOf, tiltSpecOf, wheelSpecOf, type KeyLike, type ModState } from "./inputs";

/** Movement (CSS px) below which a press-and-release is a click. */
export const DRAG_THRESHOLD_PX = 4;

interface Press {
  button: number;
  x: number;
  y: number;
  mods: ModState;
  dragged: boolean;
}

/**
 * Tracks presses per button. `down` on pointerdown, `move` on pointermove
 * (returns the button that just became a drag, once), `up` on pointerup
 * (returns "click" or "drag").
 */
export class GestureTracker {
  private presses = new Map<number, Press>();

  down(e: ModState & { button: number; clientX: number; clientY: number }): void {
    this.presses.set(e.button, { button: e.button, x: e.clientX, y: e.clientY, mods: { ...pickMods(e) }, dragged: false });
  }

  /** Buttons whose press just crossed the drag threshold. */
  move(e: { clientX: number; clientY: number }): Press[] {
    const started: Press[] = [];
    for (const p of this.presses.values()) {
      if (p.dragged) continue;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) >= DRAG_THRESHOLD_PX) {
        p.dragged = true;
        started.push(p);
      }
    }
    return started;
  }

  up(e: { button: number; clientX: number; clientY: number }): { gesture: "click" | "drag"; mods: ModState } | null {
    const p = this.presses.get(e.button);
    if (!p) return null;
    this.presses.delete(e.button);
    const moved = p.dragged || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= DRAG_THRESHOLD_PX;
    return { gesture: moved ? "drag" : "click", mods: p.mods };
  }

  cancel(): void {
    this.presses.clear();
  }
}

function pickMods(e: ModState): ModState {
  return { ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, altKey: !!e.altKey, shiftKey: !!e.shiftKey };
}

export type CaptureEvent =
  | ({ type: "keydown" } & KeyLike)
  | ({ type: "pointerdown" | "pointerup" | "mousedown" | "mouseup" | "auxclick"; button: number; clientX: number; clientY: number } & ModState)
  | ({ type: "pointermove" | "mousemove"; clientX: number; clientY: number } & ModState)
  | ({ type: "wheel"; deltaX: number; deltaY: number } & ModState);

/**
 * "Press the button or key you want to bind." Feed it raw events; it returns
 * the captured spec once the input is complete (key down; button up as a
 * click or a drag; one wheel notch), or null while it is still listening.
 * Records exactly what the OS sent: any button number, F13–F24, tilt.
 */
export class InputCapture {
  private tracker = new GestureTracker();
  constructor(private readonly mac: boolean) {}

  feed(e: CaptureEvent): string | null {
    switch (e.type) {
      case "keydown":
        return keySpecOf(e, this.mac);
      case "pointerdown":
      case "mousedown":
        this.tracker.down(e);
        return null;
      case "pointermove":
      case "mousemove":
        this.tracker.move(e);
        return null;
      case "pointerup":
      case "mouseup":
      case "auxclick": {
        const done = this.tracker.up(e);
        if (!done) {
          // Buttons whose press the OS never reported (some extra buttons only
          // arrive as auxclick): take the release as a click.
          return e.type === "auxclick" ? mouseSpecOf(e.button, "click", e, this.mac) : null;
        }
        return mouseSpecOf(e.button, done.gesture, done.mods, this.mac);
      }
      case "wheel":
        return tiltSpecOf(e, this.mac) ?? wheelSpecOf(e, this.mac);
    }
  }

  reset(): void {
    this.tracker.cancel();
  }
}
