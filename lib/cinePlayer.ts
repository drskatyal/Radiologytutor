// Cine playback timing for the stack viewport.
//
// `docs/UI_AUDIT.md` backlog #10: "No cine, no hanging-protocol layout, no
// magnify. Diagnostic viewers have them." Cine is the one of the three a
// *teaching* viewer genuinely needs: a cardiac/respiratory loop, a dynamic
// contrast series, and a fluoroscopy run are unreadable one frame at a time,
// and "scroll quickly with the wheel" is not an answer a radiologist accepts.
//
// Pure state machine. The viewer owns the timer and calls `advanceCine` on
// each tick; nothing here touches Cornerstone or the DOM, so the wrap
// behaviour and the frame budget are unit-testable.
//
// Two wrap modes, because the two uses differ:
//   loop    a true cine loop (cardiac, fluoro) — runs off the end, starts again
//   bounce  a reading sweep through an anatomic stack — reverses at the ends,
//           so the reader's eye is not yanked from diaphragm back to apex

export type CineWrap = "loop" | "bounce";

/** Frame rates offered in the toolbar. DICOM cine is usually 10–30. */
export const CINE_FPS_OPTIONS = [5, 10, 15, 20, 30] as const;
export const DEFAULT_CINE_FPS = 15;
/** Below this a cine is a slideshow; above it the decoders cannot keep up. */
export const MIN_CINE_FPS = 1;
export const MAX_CINE_FPS = 60;

export function clampCineFps(fps: number): number {
  if (!Number.isFinite(fps)) return DEFAULT_CINE_FPS;
  return Math.min(MAX_CINE_FPS, Math.max(MIN_CINE_FPS, Math.round(fps)));
}

/** Milliseconds between frames at `fps`. */
export function cineFrameMs(fps: number): number {
  return 1000 / clampCineFps(fps);
}

export interface CineState {
  /** +1 playing toward the end of the stack, -1 toward the start. */
  direction: 1 | -1;
}

export function createCineState(direction: 1 | -1 = 1): CineState {
  return { direction };
}

export interface CineStep {
  index: number;
  direction: 1 | -1;
}

/**
 * The next frame to show. Mutates `state.direction` in `bounce` mode so the
 * caller keeps one object for the life of the playback.
 *
 * A stack of 0 or 1 images has nowhere to go and reports index 0 — a cine
 * button on a single radiograph must be a no-op, not a flicker.
 */
export function advanceCine(
  state: CineState,
  index: number,
  count: number,
  wrap: CineWrap = "loop"
): CineStep {
  if (!Number.isFinite(count) || count <= 1) return { index: 0, direction: state.direction };
  const at = Math.max(0, Math.min(count - 1, Math.round(index)));
  const next = at + state.direction;
  if (next >= 0 && next < count) return { index: next, direction: state.direction };

  if (wrap === "loop") {
    // Off the end: restart at the other end, same direction.
    return { index: state.direction > 0 ? 0 : count - 1, direction: state.direction };
  }
  // Bounce: reverse and step back inside the stack.
  const direction: 1 | -1 = state.direction > 0 ? -1 : 1;
  state.direction = direction;
  return { index: at + direction, direction };
}

/**
 * Whether a cine is worth offering for this series. One frame cannot loop,
 * and on a two-frame stack the control is noise.
 */
export function cineAvailable(count: number): boolean {
  return Number.isFinite(count) && count >= 3;
}

/**
 * The frame rate to open at. A DICOM `cineModule` rate (from
 * RecommendedDisplayFrameRate / FrameTime) wins when the series carries one —
 * a cardiac loop authored at 30 fps should play at 30, not at our default.
 */
export function initialCineFps(dicomFrameRate?: number | null): number {
  if (dicomFrameRate == null || !Number.isFinite(dicomFrameRate) || dicomFrameRate <= 0) {
    return DEFAULT_CINE_FPS;
  }
  return clampCineFps(dicomFrameRate);
}
