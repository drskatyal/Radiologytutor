// Click-the-finding — compare a student click to an authored normalized marker.
// Distance is Euclidean in [0,1] image space. No pixels, no new imaging infra.

import type { Marker } from "./types";

/** Default hit radius: ~8% of the viewport diagonal-ish in unit square (~0.11 of width). */
export const DEFAULT_HIT_RADIUS = 0.08;

export function clickDistance(
  marker: Marker,
  x_pct: number,
  y_pct: number
): number {
  const dx = marker.x_pct - x_pct;
  const dy = marker.y_pct - y_pct;
  return Math.hypot(dx, dy);
}

export function clickHitsFinding(
  marker: Marker | null | undefined,
  x_pct: number,
  y_pct: number,
  radius = DEFAULT_HIT_RADIUS
): boolean {
  if (!marker) return false;
  if (!Number.isFinite(x_pct) || !Number.isFinite(y_pct)) return false;
  return clickDistance(marker, x_pct, y_pct) <= radius;
}
