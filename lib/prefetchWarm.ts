// Which frames to warm when a case opens.
//
// The viewer opens at the middle of the stack (stackOpenIndex) and Teach
// lands on each finding's sliceIndex. Warming instances[0..31] requested the
// lung apices, saturated the connection pool, and — with Accept:
// application/octet-stream — made Orthanc answer 400 once per slice. Those
// 400s showed up in the console while the tour, which never visited those
// slices, still played.

import { WADORS_FRAME_ACCEPT } from "./dicomwebProxy";
import { stackOpenIndex } from "./stackIndex";

export { WADORS_FRAME_ACCEPT };

/** How many frame fetches may be in flight. Keeps Orthanc off a 32-wide stampede. */
export const WARM_CONCURRENCY = 3;
/** Neighbors on each side of the open slice and each finding, for the cine. */
export const WARM_RADIUS = 2;
/** Hard cap across every series in the case. A full CT is not warmed. */
export const WARM_CAP = 18;

export interface WarmInstance {
  sopInstanceUID: string;
}

export interface WarmSeries {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  instances: WarmInstance[];
}

export interface WarmFocus {
  seriesInstanceUID: string;
  /** 0-based index into that series' instance list (Finding.sliceIndex). */
  sliceIndex: number;
}

export interface WarmTarget {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID: string;
}

/** Finding anchors the warmer should prefer, in teaching order. */
export function collectFocusSlices(
  findings: ReadonlyArray<{
    seriesInstanceUID?: string;
    sliceIndex?: number;
    order?: number;
  }>
): WarmFocus[] {
  const sorted = [...findings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const out: WarmFocus[] = [];
  const seen = new Set<string>();
  for (const finding of sorted) {
    const seriesInstanceUID = finding.seriesInstanceUID?.trim();
    if (!seriesInstanceUID || finding.sliceIndex == null || !Number.isFinite(finding.sliceIndex)) {
      continue;
    }
    const sliceIndex = Math.max(0, Math.round(finding.sliceIndex));
    const key = `${seriesInstanceUID}\0${sliceIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ seriesInstanceUID, sliceIndex });
  }
  return out;
}

/**
 * Frames to fetch, best first: the slice the viewport opens on, then each
 * finding, each with a small neighbor window. Deduped, clamped, capped.
 */
export function selectWarmTargets(
  series: readonly WarmSeries[],
  focus: readonly WarmFocus[],
  opts?: { radius?: number; cap?: number }
): WarmTarget[] {
  const radius = Math.max(0, opts?.radius ?? WARM_RADIUS);
  const cap = Math.max(0, opts?.cap ?? WARM_CAP);
  const out: WarmTarget[] = [];
  const seen = new Set<string>();

  const push = (entry: WarmSeries, index: number) => {
    if (out.length >= cap) return;
    if (!entry.studyInstanceUID || !entry.seriesInstanceUID) return;
    if (index < 0 || index >= entry.instances.length) return;
    const sop = entry.instances[index]?.sopInstanceUID?.trim();
    if (!sop) return;
    const key = `${entry.studyInstanceUID}/${entry.seriesInstanceUID}/${sop}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      studyInstanceUID: entry.studyInstanceUID,
      seriesInstanceUID: entry.seriesInstanceUID,
      sopInstanceUID: sop,
    });
  };

  for (const entry of series) {
    if (out.length >= cap || entry.instances.length === 0) continue;
    const foci = focus
      .filter((item) => item.seriesInstanceUID === entry.seriesInstanceUID)
      .map((item) => item.sliceIndex);
    const centers = [stackOpenIndex(entry.instances.length), ...foci];
    for (const center of centers) {
      if (out.length >= cap) break;
      const clamped = Math.max(0, Math.min(entry.instances.length - 1, Math.round(center)));
      push(entry, clamped);
      for (let distance = 1; distance <= radius; distance++) {
        push(entry, clamped - distance);
        push(entry, clamped + distance);
      }
    }
  }
  return out;
}

/** Same path shape the viewer puts in a wadors imageId (no extra encoding). */
export function wadoFrameUrl(root: string, target: WarmTarget): string {
  const base = root.replace(/\/$/, "");
  return (
    `${base}/studies/${target.studyInstanceUID}` +
    `/series/${target.seriesInstanceUID}` +
    `/instances/${target.sopInstanceUID}/frames/1`
  );
}
