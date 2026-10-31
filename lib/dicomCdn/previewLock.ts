// ============================================================================
// lib/dicomCdn/previewLock.ts  (pure)
//
// While the slice on screen is an 8-bit preview, its pixels hold only the
// default window: anything outside [lo, hi] is clipped, and every value is
// quantised to 1/255 of the window. Window/level would reveal nothing real,
// and a length/ROI/probe would read HU off quantised pixels. So those
// interactions wait for the full-quality frame (usually tens of ms on the
// current slice). Scroll, pan, zoom, invert and reset stay live.
// ============================================================================

/** Left-button tools that would read or re-window preview pixels. */
export const PREVIEW_LOCKED_TOOLS: ReadonlySet<string> = new Set([
  "WindowLevel",
  "Length",
  "Angle",
  "EllipticalROI",
  "RectangleROI",
  "Probe",
  "ArrowAnnotate",
]);

export interface PressLike {
  type: string;
  button?: number;
  touchCount?: number;
}

/**
 * Should this press be swallowed before it reaches Cornerstone's tools?
 * Only the primary button / one-finger drag carries the selected tool;
 * wheel, right-drag (zoom), middle-drag (pan) and pinch never do.
 */
export function previewBlocksPress(previewing: boolean, leftTool: string, press: PressLike): boolean {
  if (!previewing || !PREVIEW_LOCKED_TOOLS.has(leftTool)) return false;
  if (press.type === "touchstart") return press.touchCount === 1;
  if (press.type === "mousedown" || press.type === "pointerdown") return (press.button ?? 0) === 0;
  return false;
}
