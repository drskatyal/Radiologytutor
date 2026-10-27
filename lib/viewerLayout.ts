// Breakpoints and touch-tool defaults for the shared imaging stage.
//
// Tailwind `lg` is 1024px. Below that a docked series rail plus a 380px tutor
// column cover a phone (and a portrait tablet). The reading room stacks those
// chrome pieces instead, and stack-scroll is the default drag.

/** Matches Tailwind `max-lg` / `(max-width: 1023px)`. */
export const NARROW_LAYOUT_MAX_PX = 1023;

export const NARROW_LAYOUT_MEDIA = "(max-width: 1023px)";

/** Collapsed series strip. `w-11` — a 44px touch target. */
export const COLLAPSED_RAIL_PX = 44;

/** Open rail never grows past this (`w-60`). */
export const OPEN_RAIL_MAX_PX = 240;

/** Pixels kept for the image when the open rail is sharing a narrow stage (`9rem`). */
export const RAIL_IMAGE_RESERVE_PX = 144;

export function isNarrowLayout(width: number): boolean {
  return Number.isFinite(width) && width <= NARROW_LAYOUT_MAX_PX;
}

/** Tutor column is a side rail only from `lg` up. Narrow starts closed. */
export function defaultTutorRailOpen(width: number): boolean {
  return !isNarrowLayout(width);
}

export type ReadingSurface = "read" | "record";

/**
 * Student teach/read and click-the-finding exams default to stack scroll, so
 * one-finger (and left-button) vertical drag changes slice.
 * Studio record keeps window/level — teachers window before they scroll.
 */
export function defaultPrimaryTool(surface: ReadingSurface): "StackScroll" | "WindowLevel" {
  return surface === "record" ? "WindowLevel" : "StackScroll";
}

/**
 * Width left for the image when the series rail is in normal flow (not a
 * fullscreen overlay). The open rail is `min(15rem, 100% - 9rem)`.
 */
export interface FullscreenTarget {
  requestFullscreen?: () => Promise<void> | void;
  webkitRequestFullscreen?: () => void;
}

/** Native Fullscreen API when the browser allows it. Rejection means use the CSS cover. */
export async function requestStageFullscreen(el: FullscreenTarget): Promise<boolean> {
  try {
    if (typeof el.requestFullscreen === "function") {
      await el.requestFullscreen();
      return true;
    }
    if (typeof el.webkitRequestFullscreen === "function") {
      el.webkitRequestFullscreen();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function dockedImageColumnPx(viewportWidth: number, railOpen: boolean): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0;
  if (!railOpen) return Math.max(0, viewportWidth - COLLAPSED_RAIL_PX);
  const rail = Math.min(OPEN_RAIL_MAX_PX, Math.max(0, viewportWidth - RAIL_IMAGE_RESERVE_PX));
  return Math.max(0, viewportWidth - rail);
}
