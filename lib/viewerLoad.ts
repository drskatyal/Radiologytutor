// Pure planning for viewer open. No Cornerstone, no network.
//
// The stack the viewer scrolls is the series metadata array order — the same
// order `retrieveSeriesMetadata` has always produced — so a stored sliceIndex
// still lands on the image it was authored against. The opening frame is the
// last teacher slice on that series when one was stored, otherwise the middle.

import { stackOpenIndex } from "./stackIndex";
import type { CaseSeries } from "./viewerSource";

/** Neighboring slices prefetched around the current index. Not the whole series. */
export const ACTIVE_PREFETCH_RADIUS = 8;

export interface OpenSlice {
  /** 0-based index in metadata order. */
  sliceIndex?: number;
  sopInstanceUID?: string;
}

export interface SeriesHintInput {
  modality?: string;
  findings?: readonly {
    order?: number;
    studyInstanceUID?: string;
    seriesInstanceUID?: string;
  }[];
  studyRefs?: readonly {
    order?: number;
    studyInstanceUID?: string;
    seriesInstanceUIDs?: readonly string[];
  }[];
}

/** A positive DICOMweb count. Missing and 0 are unknown — never "0 images". */
export function knownInstanceCount(value: number | undefined | null): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

export function wadorsImageId(
  wadoRsRoot: string,
  studyInstanceUID: string,
  seriesInstanceUID: string,
  sopInstanceUID: string
): string {
  const base = wadoRsRoot.replace(/\/$/, "");
  return (
    `wadors:${base}/studies/${studyInstanceUID}` +
    `/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/1`
  );
}

export function dicomTagString(dataset: unknown, tag: string): string | undefined {
  if (!dataset || typeof dataset !== "object") return undefined;
  const element = (dataset as Record<string, { Value?: unknown[] } | undefined>)[tag];
  const raw = element?.Value?.[0];
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (raw && typeof raw === "object" && "Alphabetic" in raw) {
    const alphabetic = (raw as { Alphabetic?: unknown }).Alphabetic;
    if (typeof alphabetic === "string" && alphabetic.trim()) return alphabetic.trim();
  }
  return undefined;
}

export function dicomTagNumber(dataset: unknown, tag: string): number | undefined {
  const text = dicomTagString(dataset, tag);
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Last authored landing on `seriesInstanceUID` (highest finding order).
 * That is the slice the teacher left, when one was stored.
 */
export function lastTeacherSlice(
  findings: readonly {
    order?: number;
    seriesInstanceUID?: string;
    sliceIndex?: number;
    sopInstanceUID?: string;
  }[],
  seriesInstanceUID: string | undefined
): OpenSlice | undefined {
  if (!seriesInstanceUID) return undefined;
  let best: (typeof findings)[number] | undefined;
  for (const finding of findings) {
    if (finding.seriesInstanceUID !== seriesInstanceUID) continue;
    const sop = finding.sopInstanceUID?.trim();
    const hasSlice = finding.sliceIndex != null && Number.isFinite(finding.sliceIndex);
    if (!sop && !hasSlice) continue;
    if (!best || (finding.order ?? 0) >= (best.order ?? 0)) best = finding;
  }
  if (!best) return undefined;
  const sop = best.sopInstanceUID?.trim();
  return {
    ...(sop ? { sopInstanceUID: sop } : {}),
    ...(best.sliceIndex != null && Number.isFinite(best.sliceIndex)
      ? { sliceIndex: Math.max(0, Math.round(best.sliceIndex)) }
      : {}),
  };
}

/** Index to show once the ordered SOP list is known. */
export function resolveOpenIndex(
  count: number,
  sops: readonly string[],
  hint?: OpenSlice | null
): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const sop = hint?.sopInstanceUID?.trim();
  if (sop) {
    const found = sops.indexOf(sop);
    if (found >= 0) return found;
  }
  if (hint?.sliceIndex != null && Number.isFinite(hint.sliceIndex)) {
    return Math.max(0, Math.min(count - 1, Math.round(hint.sliceIndex)));
  }
  return stackOpenIndex(count);
}

/**
 * Indexes to prefetch around `center`, excluding `center` itself.
 * Clamped to the stack. A 1000-image series stays a small window.
 */
export function neighborIndexes(
  count: number,
  center: number,
  radius: number = ACTIVE_PREFETCH_RADIUS
): number[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const span = Math.max(0, Math.floor(radius));
  const at = Math.max(0, Math.min(count - 1, Math.round(center)));
  const start = Math.max(0, at - span);
  const end = Math.min(count - 1, at + span);
  const out: number[] = [];
  for (let index = start; index <= end; index++) {
    if (index !== at) out.push(index);
  }
  return out;
}

/**
 * Series the viewer can open without a DICOMweb round trip.
 * Finding order leads. Counts and thumbnails are not invented here.
 */
export function seriesHintFromCase(input: SeriesHintInput, wadoRsRoot: string): CaseSeries[] {
  const findings = [...(input.findings ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const refs = [...(input.studyRefs ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const out: CaseSeries[] = [];
  const seen = new Set<string>();

  const push = (seriesInstanceUID: string | undefined, studyInstanceUID: string | undefined) => {
    const seriesUid = seriesInstanceUID?.trim();
    if (!seriesUid || seen.has(seriesUid)) return;
    const studyUid =
      studyInstanceUID?.trim() ||
      findings.find((finding) => finding.seriesInstanceUID === seriesUid)?.studyInstanceUID ||
      refs.find((ref) => (ref.seriesInstanceUIDs ?? []).includes(seriesUid))?.studyInstanceUID ||
      refs[0]?.studyInstanceUID;
    if (!studyUid?.trim()) return;
    seen.add(seriesUid);
    out.push({
      seriesInstanceUID: seriesUid,
      studyInstanceUID: studyUid.trim(),
      modality: input.modality,
      wadoRsRoot,
    });
  };

  for (const finding of findings) push(finding.seriesInstanceUID, finding.studyInstanceUID);
  for (const ref of refs) {
    for (const seriesUid of ref.seriesInstanceUIDs ?? []) push(seriesUid, ref.studyInstanceUID);
  }
  return out;
}

/**
 * Keep the series already on screen in place and fill in DICOMweb metadata.
 * A positive measured count wins over a missing or zero tag.
 */
export function mergeSeriesRail(current: readonly CaseSeries[], incoming: readonly CaseSeries[]): CaseSeries[] {
  if (incoming.length === 0) return [...current];
  if (current.length === 0) return incoming.map(preferPositiveCount);
  const byId = new Map(incoming.map((series) => [series.seriesInstanceUID, series]));
  const seen = new Set<string>();
  const out: CaseSeries[] = [];
  for (const series of current) {
    seen.add(series.seriesInstanceUID);
    const fresh = byId.get(series.seriesInstanceUID);
    if (!fresh) {
      out.push(series);
      continue;
    }
    const count =
      knownInstanceCount(fresh.instanceCount) ?? knownInstanceCount(series.instanceCount);
    out.push({
      ...series,
      ...fresh,
      ...(count != null ? { instanceCount: count } : { instanceCount: undefined }),
      thumbnailInstanceUID: fresh.thumbnailInstanceUID || series.thumbnailInstanceUID,
    });
  }
  for (const series of incoming) {
    if (seen.has(series.seriesInstanceUID)) continue;
    out.push(preferPositiveCount(series));
  }
  return out;
}

function preferPositiveCount(series: CaseSeries): CaseSeries {
  const count = knownInstanceCount(series.instanceCount);
  if (count == null) {
    const { instanceCount: _drop, ...rest } = series;
    return rest;
  }
  return { ...series, instanceCount: count };
}
