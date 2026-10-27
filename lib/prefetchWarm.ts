// Which frames to warm when a case opens.
//
// Only the active series, and only the slice the stack opens on plus a few
// neighbors. Other series stay metadata-only until the reader selects them.
// Warming every finding, or instances[0..31], requested the wrong end of a
// chest CT and saturated the pool before the first frame.

import { WADORS_FRAME_ACCEPT } from "./dicomwebProxy";
import { stackOpenIndex } from "./stackIndex";
import { ACTIVE_PREFETCH_RADIUS, neighborIndexes } from "./viewerLoad";

export { WADORS_FRAME_ACCEPT };

/** How many frame fetches may be in flight. Keeps the archive off a stampede. */
export const WARM_CONCURRENCY = 3;
/** Neighbors on each side of the slice the active series opens on. */
export const WARM_RADIUS = ACTIVE_PREFETCH_RADIUS;
/** Hard cap. One active series, not every series in the study. */
export const WARM_CAP = ACTIVE_PREFETCH_RADIUS * 2 + 1;

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
 * Frames to fetch for the active series only: the slice the viewport opens
 * on, plus ± radius neighbors. Other series are not warmed. Findings outside
 * that window load when the reader scrolls there.
 */
export function selectWarmTargets(
  series: readonly WarmSeries[],
  _focus: readonly WarmFocus[],
  opts?: { radius?: number; cap?: number; seriesInstanceUID?: string }
): WarmTarget[] {
  const radius = Math.max(0, opts?.radius ?? WARM_RADIUS);
  const cap = Math.max(0, opts?.cap ?? WARM_CAP);
  void _focus;
  const wanted = opts?.seriesInstanceUID ?? series[0]?.seriesInstanceUID;
  const entry = series.find((item) => item.seriesInstanceUID === wanted) ?? series[0];
  if (!entry || entry.instances.length === 0) return [];
  if (!entry.studyInstanceUID || !entry.seriesInstanceUID) return [];

  const center = stackOpenIndex(entry.instances.length);
  const indexes = [center, ...neighborIndexes(entry.instances.length, center, radius)];
  const out: WarmTarget[] = [];
  const seen = new Set<string>();
  for (const index of indexes) {
    if (out.length >= cap) break;
    if (index < 0 || index >= entry.instances.length) continue;
    const sop = entry.instances[index]?.sopInstanceUID?.trim();
    if (!sop) continue;
    const key = `${entry.studyInstanceUID}/${entry.seriesInstanceUID}/${sop}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      studyInstanceUID: entry.studyInstanceUID,
      seriesInstanceUID: entry.seriesInstanceUID,
      sopInstanceUID: sop,
    });
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
