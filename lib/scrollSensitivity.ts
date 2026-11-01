// Clinical stack-scroll sensitivity.
//
// Previous wheel: Cornerstone moves exactly one slice per wheel event and
// ignores the delta. A mouse notch that the browser splits into several
// events (or a trackpad flick) therefore jumps many slices. One notch down
// and five up on a 65-slice chest CT left the aortic arch.
//
// New wheel: accumulate CSS pixels and move one slice per
// WHEEL_PIXELS_PER_SLICE (100, about one detent). A burst closer than
// WHEEL_BURST_MS (80) can contribute at most one slice, and leftover pixels
// from that burst are capped below a full step so they cannot roll into the
// next detent. A notch is one slice. A continuous trackpad gesture is about
// one slice per 100px, and never more than one slice per 80ms (~12/s).
//
// Previous drag: max(2px, viewportHeight / max(sliceCount, 8)) per slice, so
// a long CT is two pixels per slice.
// New drag: that distance times DRAG_DISTANCE_MULTIPLIER (3), with a floor
// of DRAG_MIN_PIXELS_PER_SLICE (8). Drag speed is 0.33×, or 0.25× where the
// old floor of 2px applied.

export const PREVIOUS_WHEEL_SLICES_PER_EVENT = 1;
export const WHEEL_PIXELS_PER_SLICE = 100;
export const WHEEL_BURST_MS = 80;

export const PREVIOUS_DRAG_MIN_PIXELS = 2;
export const DRAG_DISTANCE_MULTIPLIER = 3;
export const DRAG_MIN_PIXELS_PER_SLICE = 8;

/** How long a scroll must pause before neighbor prefetch runs. */
export const NEIGHBOR_PREFETCH_DELAY_MS = 200;

export interface WheelScrollState {
  y: number;
  /** performance.now() when the current one-slice window opened. */
  windowStart: number;
  slicesThisWindow: number;
}

export function createWheelScrollState(): WheelScrollState {
  return { y: 0, windowStart: Number.NEGATIVE_INFINITY, slicesThisWindow: 0 };
}

/**
 * How many slices this wheel sample may move. Positive is the sign of the
 * pixels (Cornerstone then applies its own invert flag).
 */
export function takeWheelSlices(state: WheelScrollState, pixelY: number, now: number): number {
  if (!Number.isFinite(pixelY) || pixelY === 0 || !Number.isFinite(now)) return 0;
  if (now - state.windowStart > WHEEL_BURST_MS) {
    state.windowStart = now;
    state.slicesThisWindow = 0;
  }
  const cap = WHEEL_PIXELS_PER_SLICE - 1;
  if (state.slicesThisWindow >= 1) {
    const next = state.y + pixelY;
    state.y = Math.sign(next) * Math.min(Math.abs(next), cap);
    return 0;
  }
  state.y += pixelY;
  if (Math.abs(state.y) < WHEEL_PIXELS_PER_SLICE) return 0;
  const direction = Math.sign(state.y);
  state.y -= direction * WHEEL_PIXELS_PER_SLICE;
  if (Math.abs(state.y) > cap) state.y = direction * cap;
  state.slicesThisWindow += 1;
  return direction;
}

/** Pixels of drag required to change one slice. Higher means a slower scroll. */
export function scaleDragPixelsPerSlice(cornerstonePixels: number): number {
  const base =
    Number.isFinite(cornerstonePixels) && cornerstonePixels > 0
      ? cornerstonePixels
      : PREVIOUS_DRAG_MIN_PIXELS;
  return Math.max(DRAG_MIN_PIXELS_PER_SLICE, base * DRAG_DISTANCE_MULTIPLIER);
}

/**
 * Reader-adjustable scroll feel (FlowRad Viewer Settings). Defaults reproduce
 * the behaviour above exactly, so callers that never set them are unchanged.
 */
export interface ScrollPreferences {
  /** Slices per wheel notch (1–10). */
  slicesPerNotch: number;
  /** Pixels of drag per slice; null = automatic (scaled to the series length). */
  dragPixelsPerSlice: number | null;
  /** Faster notches in a quick run move more slices (up to 4×). */
  acceleration: boolean;
}

export const DEFAULT_SCROLL_PREFERENCES: ScrollPreferences = {
  slicesPerNotch: 1,
  dragPixelsPerSlice: null,
  acceleration: false,
};

const prefs: ScrollPreferences = { ...DEFAULT_SCROLL_PREFERENCES };

export function setScrollPreferences(next: Partial<ScrollPreferences>): void {
  if (next.slicesPerNotch != null && Number.isFinite(next.slicesPerNotch)) {
    prefs.slicesPerNotch = Math.min(10, Math.max(1, Math.round(next.slicesPerNotch)));
  }
  if (next.dragPixelsPerSlice !== undefined) {
    prefs.dragPixelsPerSlice =
      next.dragPixelsPerSlice == null || !Number.isFinite(next.dragPixelsPerSlice)
        ? null
        : Math.min(60, Math.max(1, next.dragPixelsPerSlice));
  }
  if (next.acceleration != null) prefs.acceleration = next.acceleration;
}

export function getScrollPreferences(): ScrollPreferences {
  return { ...prefs };
}

/** Notches closer together than this count as one accelerating run. */
export const ACCELERATION_WINDOW_MS = 140;

/**
 * Slices for one notch, given the run so far. With acceleration off this is
 * always `slicesPerNotch`; on, the 3rd, 5th and 7th quick notch in a row add
 * one more multiple each (1×, 1×, 2×, 2×, 3×, 3×, 4×…).
 */
export function slicesForNotch(p: ScrollPreferences, runLength: number): number {
  const factor = p.acceleration ? Math.min(4, 1 + Math.floor(Math.max(0, runLength - 1) / 2)) : 1;
  return p.slicesPerNotch * factor;
}

/** Drag distance per slice under the current preferences. */
export function dragPixelsPerSlice(cornerstonePixels: number, p: ScrollPreferences = prefs): number {
  return p.dragPixelsPerSlice ?? scaleDragPixelsPerSlice(cornerstonePixels);
}

interface StackScrollWheelEvent {
  detail?: {
    wheel?: { pixelY?: number; direction?: number; spinY?: number };
  };
}

interface StackScrollInstance {
  configuration?: { debounceIfNotLoaded?: boolean };
  mouseWheelCallback?: (evt: StackScrollWheelEvent) => void;
  _getPixelPerImage?: (viewport: unknown) => number;
  __radlearnScroll?: boolean;
}

/**
 * Slow the live StackScroll instance. Wheel and drag stay on the tool, so
 * MPR and the stack share one feel. Safe to call twice.
 */
export function tuneStackScrollTool(tool: unknown): void {
  if (!tool || typeof tool !== "object") return;
  const instance = tool as StackScrollInstance;
  if (instance.__radlearnScroll) return;
  instance.__radlearnScroll = true;

  // "One slice per wheel step." With Cornerstone's default debounce, a step
  // whose frame is not decoded yet only moves a TARGET index; the next step
  // adds to that target and the first slice is never painted — on a 620 ms
  // archive two quick notches read as one jump of 2. Without the debounce
  // every step is requested and painted in order (and ±10 prefetch means it
  // is usually already local).
  if (instance.configuration) instance.configuration.debounceIfNotLoaded = false;

  const state = createWheelScrollState();
  let run = { last: Number.NEGATIVE_INFINITY, length: 0 };
  const originalWheel = instance.mouseWheelCallback?.bind(instance);
  const originalPixels = instance._getPixelPerImage?.bind(instance);

  if (originalPixels) {
    instance._getPixelPerImage = (viewport) => dragPixelsPerSlice(originalPixels(viewport));
  }

  if (!originalWheel) return;
  instance.mouseWheelCallback = (evt) => {
    const wheel = evt.detail?.wheel;
    const raw = wheel?.pixelY;
    const direction = wheel?.direction ?? 0;
    const pixelY =
      typeof raw === "number" && Number.isFinite(raw) && raw !== 0
        ? raw
        : direction * WHEEL_PIXELS_PER_SLICE;
    if (!pixelY) {
      originalWheel(evt);
      return;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const steps = takeWheelSlices(state, pixelY, now);
    if (steps === 0 || !wheel) return;
    run = now - run.last < ACCELERATION_WINDOW_MS ? { last: now, length: run.length + 1 } : { last: now, length: 1 };
    const count = Math.abs(steps) * slicesForNotch(prefs, run.length);
    const sign = Math.sign(steps);
    const forged: StackScrollWheelEvent = {
      ...evt,
      detail: {
        ...evt.detail,
        wheel: { ...wheel, direction: sign, spinY: sign, pixelY },
      },
    };
    for (let i = 0; i < count; i += 1) originalWheel(forged);
  };
}
