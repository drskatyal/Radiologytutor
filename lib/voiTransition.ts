/**
 * Adaptive window/level transitions — feel like a radiologist scrolling
 * the WW/WC when the change is small; jump when presets are far apart
 * (e.g. bone → lung) so we don't spend a second tweening through garbage.
 */

/** ΔWW or ΔWC above this → snap (direct). Below → eased scroll. Mid of 100–200. */
export const VOI_SMOOTH_MAX_DELTA = 150;

export type VoiTransitionOpts = {
  /** Max |Δww| or |Δwc| that still scrolls (default 150). */
  smoothMaxDelta?: number;
  /** Duration at the smooth threshold (default 900ms). */
  smoothMs?: number;
  /** Floor duration for tiny nudges (default 280ms). */
  minMs?: number;
  /** Duration when above threshold — 0 = instant snap (default 0). */
  snapMs?: number;
};

/**
 * Pick a VOI tween duration from current → target WW/WC.
 * - Small deltas: eased scroll scaled by magnitude (radiologist feel).
 * - Large deltas (bone↔lung): direct jump.
 */
export function voiTransitionMs(
  fromWw: number,
  fromWc: number,
  toWw: number,
  toWc: number,
  opts: VoiTransitionOpts = {}
): number {
  if (
    ![fromWw, fromWc, toWw, toWc].every((n) => Number.isFinite(n))
  ) {
    return opts.snapMs ?? 0;
  }
  const delta = Math.max(Math.abs(toWw - fromWw), Math.abs(toWc - fromWc));
  const threshold = opts.smoothMaxDelta ?? VOI_SMOOTH_MAX_DELTA;
  if (delta > threshold) return opts.snapMs ?? 0;
  if (delta < 1) return 0;
  const maxMs = opts.smoothMs ?? 900;
  const minMs = opts.minMs ?? 280;
  const t = delta / threshold;
  return Math.round(minMs + t * (maxMs - minMs));
}
