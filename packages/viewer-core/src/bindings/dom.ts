// DOM plumbing for mouse buttons and wheel tilt bound to one-shot commands,
// shared by the desktop app and the web viewer. Drags and the vertical wheel
// stay with each viewport (they need its camera); this listener handles the
// rest: clicks of the middle / back / forward / any extra button, and
// horizontal wheel / tilt notches — whatever the OS delivers for the mouse,
// programmable and gaming mice included (no vendor SDK).
//
// Browser defaults (back / forward navigation on buttons 4 / 5, middle-click
// autoscroll, horizontal page scroll) are suppressed ONLY inside the viewer and
// ONLY for inputs that are bound.

import { GestureTracker } from "./gesture";
import { isMac, mouseSpecOf, tiltSpecOf } from "./inputs";

export interface MouseCommandOptions {
  /** Is this event inside the viewer (not a panel, menu, dialog or field)? */
  within: (target: EventTarget | null) => boolean;
  /** Is the spec bound to a command? (cheap; called on press) */
  isBound: (spec: string) => boolean;
  /** Run the command bound to `spec`. Return true when it ran. */
  run: (spec: string) => boolean;
  mac?: boolean;
}

/** One tilt notch per this many ms (tilt wheels repeat while held). */
const TILT_REPEAT_MS = 180;

export function attachMouseCommands(target: Window | HTMLElement, opts: MouseCommandOptions): () => void {
  const mac = opts.mac ?? isMac();
  const tracker = new GestureTracker();
  const handled = new Map<number, number>();
  let lastTilt = 0;

  const onDown = (raw: Event) => {
    const e = raw as PointerEvent;
    // Left = the selected tool; right = drag tools and the image menu.
    if (e.button === 0 || e.button === 2 || !opts.within(e.target)) return;
    tracker.down(e);
    // Middle-click autoscroll and similar defaults, only for a bound button.
    if (opts.isBound(mouseSpecOf(e.button, "click", e, mac))) e.preventDefault();
  };
  const onMove = (raw: Event) => {
    tracker.move(raw as PointerEvent);
  };
  const onUp = (raw: Event) => {
    const e = raw as PointerEvent;
    if (e.button === 0 || e.button === 2) return;
    const done = tracker.up(e);
    if (!done || done.gesture !== "click" || !opts.within(e.target)) return;
    const spec = mouseSpecOf(e.button, "click", done.mods, mac);
    if (!opts.isBound(spec)) return;
    // Back / forward: stop the webview navigating before the command runs.
    e.preventDefault();
    e.stopPropagation();
    if (opts.run(spec)) handled.set(e.button, performance.now());
  };
  /** Chromium navigates on mouseup of buttons 4 / 5 unless it is cancelled. */
  const onMouseUp = (raw: Event) => {
    const e = raw as MouseEvent;
    if (e.button < 3 || !opts.within(e.target)) return;
    if (opts.isBound(mouseSpecOf(e.button, "click", e, mac))) e.preventDefault();
  };
  /** Some extra buttons arrive only as auxclick (no pointer events): run them here. */
  const onAux = (raw: Event) => {
    const e = raw as MouseEvent;
    if (e.button === 0 || e.button === 2 || !opts.within(e.target)) return;
    const spec = mouseSpecOf(e.button, "click", e, mac);
    if (!opts.isBound(spec)) return;
    e.preventDefault();
    const at = handled.get(e.button);
    if (at !== undefined && performance.now() - at < 400) {
      handled.delete(e.button);
      return;
    }
    if (opts.run(spec)) handled.delete(e.button);
  };
  const onWheel = (raw: Event) => {
    const e = raw as WheelEvent;
    if (!opts.within(e.target)) return;
    const spec = tiltSpecOf(e, mac);
    if (!spec || !opts.isBound(spec)) return;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    if (now - lastTilt < TILT_REPEAT_MS) return;
    lastTilt = now;
    opts.run(spec);
  };

  const capture = { capture: true } as const;
  target.addEventListener("pointerdown", onDown, capture);
  target.addEventListener("pointermove", onMove, { capture: true, passive: true });
  target.addEventListener("pointerup", onUp, capture);
  target.addEventListener("mouseup", onMouseUp, capture);
  target.addEventListener("auxclick", onAux, capture);
  target.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    target.removeEventListener("pointerdown", onDown, capture);
    target.removeEventListener("pointermove", onMove, capture);
    target.removeEventListener("pointerup", onUp, capture);
    target.removeEventListener("mouseup", onMouseUp, capture);
    target.removeEventListener("auxclick", onAux, capture);
    target.removeEventListener("wheel", onWheel, capture);
  };
}
