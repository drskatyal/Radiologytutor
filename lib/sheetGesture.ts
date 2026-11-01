// Swipe thresholds shared by the bottom sheet (dismiss) and the stage handle
// (open). Pure so the feel is unit-tested, not tuned by eye per component.

/** Drag distance (px) that commits a swipe on its own. */
export const SWIPE_DISTANCE_PX = 80;
/** Flick speed (px/s) that commits a short swipe. */
export const SWIPE_VELOCITY_PX_S = 500;

/** Downward drag of a bottom sheet: close it? (offset/velocity > 0 = down). */
export function shouldDismissSheet(offsetY: number, velocityY: number): boolean {
  if (!Number.isFinite(offsetY) || !Number.isFinite(velocityY)) return false;
  return offsetY > SWIPE_DISTANCE_PX || (offsetY > 16 && velocityY > SWIPE_VELOCITY_PX_S);
}

/**
 * Upward swipe on the stage's handle: open the series drawer? Mostly vertical,
 * far or fast enough. dy < 0 is up; durationMs is the gesture length.
 */
export function isSwipeUp(dx: number, dy: number, durationMs: number): boolean {
  if (![dx, dy, durationMs].every(Number.isFinite) || durationMs <= 0) return false;
  if (dy >= 0 || Math.abs(dx) > Math.abs(dy)) return false;
  const distance = -dy;
  const speed = (distance / durationMs) * 1000;
  return distance > SWIPE_DISTANCE_PX / 2 || (distance > 16 && speed > SWIPE_VELOCITY_PX_S);
}

/** Short haptic tick where the platform has one (Android Chrome); silent elsewhere. */
export function hapticTick(ms = 10): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(ms);
  } catch {
    /* some browsers throw without a user gesture */
  }
}
