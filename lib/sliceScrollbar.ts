// Geometry for the stack's slice scrollbar.
//
// `docs/UI_AUDIT.md` backlog #2: "Slice scrollbar on the right edge of the
// stack (OHIF `ViewportSliceProgressScrollbar`). Wheel-only scroll is
// invisible." A reader who has never used this app cannot tell a 240-slice CT
// from a single radiograph, cannot tell where in the stack they are, and
// cannot jump to the end without spinning the wheel 240 times.
//
// Pure arithmetic over (index, count, track height). No DOM, no React — the
// viewer renders a track and a thumb from `thumbGeometry` and converts drags
// through `indexFromPointer`.
//
// Conventions:
//   • `index` is 0-based, the same index Cornerstone reports.
//   • A fraction of 0 is the FIRST slice and 1 is the LAST. On a 1-image
//     stack every fraction is 0 — there is nothing to scroll.
//   • The thumb has a minimum pixel height so a 1200-slice CT still gives
//     the reader something to grab.

/** Smallest thumb we will draw, in CSS pixels. Below this it is ungrabbable. */
export const MIN_THUMB_PX = 24;

export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(index)));
}

/** Position of `index` along the track, 0 (first slice) to 1 (last slice). */
export function scrollbarFraction(index: number, count: number): number {
  if (!Number.isFinite(count) || count <= 1) return 0;
  return clampIndex(index, count) / (count - 1);
}

/** The slice at `fraction` of the track. Inverse of `scrollbarFraction`. */
export function indexFromFraction(fraction: number, count: number): number {
  if (!Number.isFinite(count) || count <= 1) return 0;
  if (!Number.isFinite(fraction)) return 0;
  const clamped = Math.max(0, Math.min(1, fraction));
  return Math.round(clamped * (count - 1));
}

/**
 * The slice under a pointer at `clientY`, given the track's bounding box.
 *
 * The thumb has a floor height, so the travel available to the pointer is
 * shorter than the track by that floor. Mapping against the raw track would
 * make the last slices unreachable on a long series (the thumb would run off
 * the bottom before the pointer did).
 */
export function indexFromPointer(
  clientY: number,
  track: { top: number; height: number },
  count: number,
  minThumbPx: number = MIN_THUMB_PX
): number {
  if (!Number.isFinite(count) || count <= 1) return 0;
  if (!Number.isFinite(clientY) || !Number.isFinite(track.height) || track.height <= 0) return 0;
  const thumb = Math.min(track.height, Math.max(0, minThumbPx));
  const travel = track.height - thumb;
  if (travel <= 0) return 0;
  const at = clientY - track.top - thumb / 2;
  return indexFromFraction(at / travel, count);
}

export interface ThumbGeometry {
  /** Thumb top as a percentage of the track height. */
  topPct: number;
  /** Thumb height as a percentage of the track height. */
  heightPct: number;
}

/**
 * Where to draw the thumb. Its height is the share of the series one slice
 * represents — so the reader can see at a glance that this is a 1200-slice
 * volume — floored at `minThumbPx` so it stays grabbable.
 */
export function thumbGeometry(
  index: number,
  count: number,
  trackPx: number,
  minThumbPx: number = MIN_THUMB_PX
): ThumbGeometry {
  if (!Number.isFinite(count) || count <= 1 || !Number.isFinite(trackPx) || trackPx <= 0) {
    return { topPct: 0, heightPct: 100 };
  }
  const floorPct = (Math.min(trackPx, Math.max(0, minThumbPx)) / trackPx) * 100;
  const heightPct = Math.min(100, Math.max(floorPct, (1 / count) * 100));
  const topPct = scrollbarFraction(index, count) * (100 - heightPct);
  return { topPct, heightPct };
}

/**
 * Slices a keyboard press should move. `shift` is the coarse step, so a reader
 * can cross a chest CT in a dozen presses.
 *
 * Returns `null` for a key this scrollbar does not own, so the caller can let
 * it through.
 */
export function sliceStepForKey(
  key: string,
  count: number,
  modifiers?: { shift?: boolean }
): number | null {
  const coarse = Math.max(2, Math.round(Math.max(1, count) / 20));
  const step = modifiers?.shift ? coarse : 1;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return step;
    case "ArrowUp":
    case "ArrowLeft":
      return -step;
    case "PageDown":
      return coarse;
    case "PageUp":
      return -coarse;
    default:
      return null;
  }
}
