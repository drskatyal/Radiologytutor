// Synced scrolling by anatomy, not by slice number.
//
// Each stack's slice positions are projected on its own slice normal; the
// target viewport goes to the slice nearest the source position plus a
// registration offset (prior studies: see hangingProtocols.priorOffsetMm).
// Stacks without positions fall back to the same fraction of the stack.

export type Vec3 = readonly [number, number, number] | readonly number[];

export function sliceNormalOf(iop?: readonly number[] | null): [number, number, number] | null {
  if (!iop || iop.length < 6) return null;
  const [r1, r2, r3, c1, c2, c3] = iop;
  const n: [number, number, number] = [r2 * c3 - r3 * c2, r3 * c1 - r1 * c3, r1 * c2 - r2 * c1];
  const len = Math.hypot(...n);
  return len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : null;
}

/** Position of each slice along `normal` (mm); NaN where a slice has no position. */
export function positionsAlong(ipps: readonly (Vec3 | null | undefined)[], normal: Vec3): number[] {
  return ipps.map((p) => (p && p.length >= 3 ? p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2] : Number.NaN));
}

export function nearestIndex(positions: readonly number[], z: number): number {
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 1) {
    const d = Math.abs(positions[i] - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export interface SyncStack {
  /** Slice positions along the stack normal (from `positionsAlong`). */
  positions: readonly number[];
  /** mm added to this stack's positions to put it in the shared frame (0 for the reference). */
  offsetMm?: number;
  /** Unit normal, to check the stacks are parallel. */
  normal?: Vec3 | null;
}

/**
 * Which target slice to show for `sourceIndex`. Same-orientation stacks with
 * positions sync by position (+ offsets); anything else by stack fraction.
 * Returns -1 when the target has no slices.
 */
export function syncTargetIndex(source: SyncStack, sourceIndex: number, target: SyncStack): number {
  const n = target.positions.length;
  if (!n) return -1;
  const parallel =
    !source.normal || !target.normal
      ? true
      : Math.abs(source.normal[0] * target.normal[0] + source.normal[1] * target.normal[1] + source.normal[2] * target.normal[2]) > 0.95;
  const z = source.positions[sourceIndex];
  const usable = parallel && Number.isFinite(z) && target.positions.some(Number.isFinite);
  if (usable) {
    // Shared frame: position + own offset. Target position wanted: zShared − target offset.
    const shared = z + (source.offsetMm ?? 0);
    return nearestIndex(target.positions, shared - (target.offsetMm ?? 0));
  }
  const fraction = source.positions.length > 1 ? sourceIndex / (source.positions.length - 1) : 0;
  return Math.round(fraction * (n - 1));
}
