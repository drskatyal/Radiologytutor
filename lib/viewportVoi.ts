/**
 * Which window the primary viewport must show.
 *
 * Cornerstone reloads each slice's DICOM window unless the VOI was locked
 * with setProperties. The lock is skipped when the requested range already
 * matches the image — the LIDC soft-tissue default, W 400 / L 40 — so a
 * later setImageIdIndex puts that default back. A layout paint can do the
 * same with a readout it captured before the teach beat moved on.
 *
 * The last requested window (guide beat, preset, or the user's own gesture)
 * wins over both.
 */

export interface Voi {
  ww: number;
  wc: number;
}

export interface VoiRange {
  lower: number;
  upper: number;
}

/** Corner readout rounds to the nearest HU. A 1-unit gap still matches. */
export const VOI_READOUT_TOLERANCE = 1;

export function finiteVoi(ww: number, wc: number): Voi | null {
  if (!Number.isFinite(ww) || !Number.isFinite(wc) || ww <= 0) return null;
  return { ww, wc };
}

export function wwWcToVoi(ww: number, wc: number): VoiRange {
  return { lower: wc - ww / 2, upper: wc + ww / 2 };
}

export function voiToWwWc(voi?: VoiRange | null): Voi | null {
  if (!voi || !Number.isFinite(voi.lower) || !Number.isFinite(voi.upper)) return null;
  const ww = voi.upper - voi.lower;
  const wc = (voi.upper + voi.lower) / 2;
  if (!Number.isFinite(ww) || ww <= 0 || !Number.isFinite(wc)) return null;
  return { ww, wc };
}

export function voiNear(
  live: Voi | null | undefined,
  wanted: Voi,
  tolerance = VOI_READOUT_TOLERANCE
): boolean {
  if (!live) return false;
  return (
    Math.abs(live.ww - wanted.ww) <= tolerance &&
    Math.abs(live.wc - wanted.wc) <= tolerance
  );
}

/**
 * Window that must be on screen. A teach or user request beats the DICOM
 * default a slice just applied, and beats a layout snapshot taken earlier.
 */
export function resolveViewportVoi(args: {
  requested: Voi | null;
  live?: Voi | null;
  image?: Voi | null;
}): Voi | null {
  if (args.requested) return args.requested;
  if (args.live) return args.live;
  if (args.image) return args.image;
  return null;
}

/**
 * setProperties calls that lock the window in Cornerstone.
 * An equal range returns before voiUpdatedWithSetProperties is set, so the
 * next slice restores the image window. A one-HU prelude forces that lock,
 * then the exact range is written. Empty means it is already showing and locked.
 */
export function voiWriteSteps(
  current: VoiRange | null | undefined,
  ww: number,
  wc: number,
  opts?: { locked?: boolean }
): VoiRange[] {
  const target = wwWcToVoi(ww, wc);
  const same =
    !!current && current.lower === target.lower && current.upper === target.upper;
  if (same && opts?.locked) return [];
  if (same) return [{ lower: target.lower, upper: target.upper + 1 }, target];
  return [target];
}

export interface TeachVoiState {
  /** Last window a guide beat, preset, or user gesture asked for. */
  requested: Voi | null;
  ww: number | null;
  wc: number | null;
}

export function initialTeachVoi(image?: Voi | null): TeachVoiState {
  return {
    requested: null,
    ww: image?.ww ?? null,
    wc: image?.wc ?? null,
  };
}

/** Guide, preset, or the window tool asked for this window. */
export function requestTeachVoi(state: TeachVoiState, ww: number, wc: number): TeachVoiState {
  const requested = finiteVoi(ww, wc);
  if (!requested) return state;
  return { requested, ww: requested.ww, wc: requested.wc };
}

/**
 * A slice finished and the image window was applied, or a layout paint is
 * about to write a readout it captured earlier. The request still wins.
 */
export function settleTeachVoi(
  state: TeachVoiState,
  incoming: { ww?: number; wc?: number } | null
): TeachVoiState {
  const image =
    incoming && incoming.ww != null && incoming.wc != null
      ? finiteVoi(incoming.ww, incoming.wc)
      : null;
  const live =
    state.ww != null && state.wc != null ? { ww: state.ww, wc: state.wc } : null;
  const next = resolveViewportVoi({ requested: state.requested, live, image });
  if (!next) return state;
  return { requested: state.requested, ww: next.ww, wc: next.wc };
}

/** Reset view. The next slice may use the image window again. */
export function clearTeachVoi(state: TeachVoiState, image?: Voi | null): TeachVoiState {
  return {
    requested: null,
    ww: image?.ww ?? null,
    wc: image?.wc ?? null,
  };
}
