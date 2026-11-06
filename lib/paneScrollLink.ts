// Linked scrolling between the free viewer's panes (/viewer, hanging
// layouts): scroll one pane and every other pane showing the same plane goes
// to the same place in the patient. Like the desktop's F5 and the web pop-out
// (usePopOutWindows.ts), by patient position along the slice normal, not by
// image number: a 2.5 mm and a 5 mm series of the same study stay level.
//
// Two studies (a prior and a current) do not share a patient coordinate
// system, so a pane from another study is linked "at what it shows now" (the
// desktop's Mod+Shift+L): the offset between the two positions when linking
// starts is kept while scrolling.
//
// Pure; numbers only, nothing about the patient.

import { nearestIndex, positionsAlong, sliceNormalOf, type LocalSeries } from "@flowrad/viewer-core";

export type Vec3 = [number, number, number];

export interface PaneGeometry {
  /** Unit slice normal. */
  normal: Vec3;
  /** Position of each image (frames of one instance share it) along `normal`, in mm. */
  positions: number[];
}

/** Slice positions of a series along its normal, image by image; null without usable geometry. */
export function seriesGeometry(series: LocalSeries | null | undefined): PaneGeometry | null {
  if (!series) return null;
  const normal = sliceNormalOf(series.instances.find((i) => i.imageOrientationPatient)?.imageOrientationPatient);
  if (!normal) return null;
  const ipps = series.instances.flatMap((i) =>
    Array.from({ length: Math.max(1, i.numberOfFrames ?? 1) }, () => i.imagePositionPatient as Vec3 | undefined)
  );
  const positions = positionsAlong(ipps, normal);
  return positions.length > 0 && positions.every(Number.isFinite) ? { normal, positions } : null;
}

/**
 * +1 or −1 when the two planes are parallel (same or opposite normal, within
 * ~18°), 0 when they are not (an axial pane never drives a sagittal one).
 */
export function planeSign(a: PaneGeometry, b: PaneGeometry): 1 | -1 | 0 {
  const dot = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
  if (dot >= 0.95) return 1;
  if (dot <= -0.95) return -1;
  return 0;
}

/**
 * The image `dst` should show when `src` shows `srcIndex`, or null (not
 * parallel, or no such image). `offsetMm` is in `dst`'s own coordinate along
 * its normal: 0 within a study, the "linked at now" offset across studies.
 */
export function linkedIndex(src: PaneGeometry, srcIndex: number, dst: PaneGeometry, offsetMm = 0): number | null {
  const sign = planeSign(src, dst);
  const z = src.positions[srcIndex];
  if (!sign || z == null || dst.positions.length === 0) return null;
  const index = nearestIndex(dst.positions, sign * z + offsetMm);
  return index >= 0 ? index : null;
}

/** The offset that keeps `dst` at `dstIndex` while `src` is at `srcIndex` (link "at now"). */
export function offsetAt(src: PaneGeometry, srcIndex: number, dst: PaneGeometry, dstIndex: number): number {
  const sign = planeSign(src, dst) || 1;
  const a = src.positions[srcIndex];
  const b = dst.positions[dstIndex];
  return a == null || b == null ? 0 : b - sign * a;
}
