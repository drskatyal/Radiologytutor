// ============================================================================
// lib/prefetch.ts
//
// Server-side prefetch helpers (CLAUDE.md §4a "Performance"). It's a teaching
// app — the navigation path is known ahead of time — so we precompute exactly
// which series + instances a case will display and hand the client a manifest
// it can use to warm the /api/dicomweb cache with idle/low-priority fetches.
//
// Finding-first, and off the first-pixel path:
//   • seriesOrder is the finding walk-through (not archive series-number order).
//   • The case page does not wait on this manifest. Enumerating every instance
//     of every series before HTML was the multi-series open bottleneck.
//   • On OPEN, the viewer prefetches the active series ± a few neighbors
//     (lib/viewerLoad.ts) after the first frame is requested. Other series
//     stay metadata-only until selected.
//   • Frames may later be served from the R2 cache (lib/r2.ts) via the
//     DICOMweb proxy.
//
// Two products:
//   1. listCaseCover(caseId)      — cheap cover metadata for the case LIST.
//   2. buildPrefetchManifest(caseId) — ordered series + instance refs the
//      case's findings will walk through, for warming the cache on case OPEN.
//
// All Orthanc access stays behind lib/orthanc.ts. These are server-only.
// ============================================================================

import { getCaseForOrg, DEFAULT_ORG_ID } from "./cases";
import {
  orthancConfigured,
  orthancFindStudyByUID,
  orthancStudySeriesMeta,
  type SeriesMeta,
  type InstanceRef,
} from "./orthanc";
import { collectFocusSlices, type WarmFocus } from "./prefetchWarm";
import type { Case, CaseStudyRef } from "./types";
import type { CaseSeries } from "./viewerSource";

// ---------------------------------------------------------------------------
// Case-list cover
// ---------------------------------------------------------------------------

/** Lightweight cover descriptor shown on the case-list card. */
export interface CaseCover {
  caseId: string;
  title: string;
  modality: string;
  /** First series of the case's first study, if resolvable from Orthanc. */
  coverSeriesInstanceUID?: string;
  /** First slice's SOP Instance UID — enough to render a thumbnail. */
  coverInstanceUID?: string;
  /** Whether imaging metadata could be resolved (Orthanc configured + found). */
  hasImaging: boolean;
}

/**
 * Resolve a case's cover: the first series + first-instance UID of its first
 * study. Cheap (one study + series metadata read). Returns a cover even when
 * Orthanc is unconfigured (hasImaging:false) so the list still renders.
 */
export async function listCaseCover(
  caseId: string,
  orgId: string = DEFAULT_ORG_ID
): Promise<CaseCover | null> {
  const c = await getCaseForOrg(orgId, caseId);
  if (!c) return null;

  const base: CaseCover = {
    caseId: c.caseId,
    title: c.title,
    modality: c.modality,
    hasImaging: false,
  };

  const firstStudyUID = primaryStudyUID(c);
  if (!firstStudyUID || !orthancConfigured()) return base;

  try {
    const orthancStudyId = await orthancFindStudyByUID(firstStudyUID);
    if (!orthancStudyId) return base;
    const series = await orthancStudySeriesMeta(orthancStudyId);
    const cover = series[0];
    if (!cover) return base;
    return {
      ...base,
      coverSeriesInstanceUID: cover.seriesInstanceUID,
      coverInstanceUID: cover.firstInstanceUID,
      hasImaging: true,
    };
  } catch {
    // Cover is best-effort; never block the list.
    return base;
  }
}

// ---------------------------------------------------------------------------
// Case-open prefetch manifest
// ---------------------------------------------------------------------------

/** One series in the manifest, with the ordered instances it contributes. */
export interface PrefetchSeries {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  meta?: SeriesMeta;
  /** Ordered SOP Instance UIDs to warm, in display order. */
  instances: InstanceRef[];
}

/**
 * The prefetch manifest a case hands the client on open. `series` is already
 * in finding-first order so the client can warm series[0] immediately, then
 * remaining series in parallel (target: interactive within 30s).
 */
export interface PrefetchManifest {
  caseId: string;
  /** All study UIDs the case references (prior + current). */
  studyInstanceUIDs: string[];
  /** Series UIDs in the order the case's findings need them. */
  seriesOrder: string[];
  series: PrefetchSeries[];
  /** True when imaging metadata resolved from Orthanc; else manifest is sparse. */
  hasImaging: boolean;
  /**
   * Finding slice indexes (0-based, teaching order). The client warms these
   * and the stack's opening slice — not a prefix of the series.
   */
  focus: WarmFocus[];
}

/**
 * Series order + finding focus for a case. Instance SOP lists are intentionally
 * empty: resolving every slice of every series blocked the first frame. The
 * viewer loads the active series itself and prefetches only its neighbors.
 */
export async function buildPrefetchManifest(
  caseId: string,
  orgId: string = DEFAULT_ORG_ID
): Promise<PrefetchManifest | null> {
  const c = await getCaseForOrg(orgId, caseId);
  if (!c) return null;

  const { studyUIDs, seriesOrder } = collectRefs(c);

  return {
    caseId: c.caseId,
    studyInstanceUIDs: studyUIDs,
    seriesOrder,
    series: seriesOrder.map((seriesUID) => ({
      studyInstanceUID: studyForSeries(c, seriesUID) ?? studyUIDs[0] ?? "",
      seriesInstanceUID: seriesUID,
      instances: [],
    })),
    hasImaging: false,
    focus: collectFocusSlices(c.findings),
  };
}

// ---------------------------------------------------------------------------
// Case-open series rail (the PACS series navigator)
// ---------------------------------------------------------------------------

/**
 * Resolve the full set of series a case can show, as a `CaseSeries[]` the
 * SeriesNavigator + viewer consume. We enumerate every study the case
 * references (via `studyRefs`, falling back to the studies its findings anchor
 * to) and list each study's series from Orthanc. When a study ref names a
 * subset of `seriesInstanceUIDs`, we keep only those; otherwise all series of
 * the study are offered.
 *
 * Ordering: the series the findings need first lead the rail (so the case opens
 * on the right series), then any remaining series in study/seriesNumber order.
 *
 * Returns `null` when imaging can't be resolved (Orthanc off, or no study
 * found) so callers can fall back to the bundled single-series sample.
 */
export async function resolveCaseSeries(
  caseId: string,
  orgId: string = DEFAULT_ORG_ID,
  wadoRsRoot = "/api/dicomweb"
): Promise<CaseSeries[] | null> {
  const c = await getCaseForOrg(orgId, caseId);
  if (!c || !orthancConfigured()) return null;

  const { studyUIDs, seriesOrder } = collectRefs(c);
  if (studyUIDs.length === 0) return null;

  // Subset filter per study ref (empty/absent = use all series of the study).
  const subsetByStudy = new Map<string, Set<string>>();
  for (const ref of c.studyRefs ?? []) {
    const subset = ref.seriesInstanceUIDs ?? [];
    if (subset.length > 0) subsetByStudy.set(ref.studyInstanceUID, new Set(subset));
  }

  // List every referenced study's series from Orthanc (best-effort per study).
  const byUID = new Map<string, CaseSeries>();
  await Promise.all(
    studyUIDs.map(async (studyUID) => {
      try {
        const orthancStudyId = await orthancFindStudyByUID(studyUID);
        if (!orthancStudyId) return;
        const metas = await orthancStudySeriesMeta(orthancStudyId);
        const subset = subsetByStudy.get(studyUID);
        for (const m of metas) {
          if (subset && !subset.has(m.seriesInstanceUID)) continue;
          if (byUID.has(m.seriesInstanceUID)) continue;
          byUID.set(m.seriesInstanceUID, {
            seriesInstanceUID: m.seriesInstanceUID,
            studyInstanceUID: studyUID,
            modality: m.modality,
            description: m.seriesDescription,
            seriesNumber: m.seriesNumber,
            ...(m.instanceCount != null && m.instanceCount > 0
              ? { instanceCount: m.instanceCount }
              : {}),
            thumbnailInstanceUID: m.firstInstanceUID,
            wadoRsRoot,
          });
        }
      } catch {
        // Skip a study we can't resolve; the rest of the rail still renders.
      }
    })
  );

  if (byUID.size === 0) return null;

  // Order: finding-driven series first, then the rest by study then series#.
  const ordered: CaseSeries[] = [];
  const taken = new Set<string>();
  for (const uid of seriesOrder) {
    const s = byUID.get(uid);
    if (s && !taken.has(uid)) {
      ordered.push(s);
      taken.add(uid);
    }
  }
  const rest = [...byUID.values()]
    .filter((s) => !taken.has(s.seriesInstanceUID))
    .sort(
      (a, b) =>
        studyUIDs.indexOf(a.studyInstanceUID) - studyUIDs.indexOf(b.studyInstanceUID) ||
        (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0)
    );
  return [...ordered, ...rest];
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** The case's primary (first) study UID, preferring an explicit "current" ref. */
function primaryStudyUID(c: Case): string | undefined {
  const refs = orderedStudyRefs(c);
  const current = refs.find((r) => r.role === "current");
  return (current ?? refs[0])?.studyInstanceUID;
}

function orderedStudyRefs(c: Case): CaseStudyRef[] {
  return (c.studyRefs ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Map a series UID back to its study UID using the case's studyRefs. */
function studyForSeries(c: Case, seriesUID: string): string | undefined {
  for (const ref of c.studyRefs ?? []) {
    if ((ref.seriesInstanceUIDs ?? []).includes(seriesUID)) return ref.studyInstanceUID;
  }
  return undefined;
}

/**
 * Collect the ordered set of study + series UIDs a case needs. Series order is
 * driven by the findings (the actual teaching sequence); studyRefs fill in any
 * series not yet anchored by a finding.
 */
function collectRefs(c: Case): { studyUIDs: string[]; seriesOrder: string[] } {
  const studyUIDs: string[] = [];
  const seriesOrder: string[] = [];
  const seenStudies = new Set<string>();
  const seenSeries = new Set<string>();

  const addStudy = (uid?: string) => {
    if (uid && !seenStudies.has(uid)) {
      seenStudies.add(uid);
      studyUIDs.push(uid);
    }
  };
  const addSeries = (uid?: string) => {
    if (uid && !seenSeries.has(uid)) {
      seenSeries.add(uid);
      seriesOrder.push(uid);
    }
  };

  // 1. Studies in case order (prior/current).
  for (const ref of orderedStudyRefs(c)) addStudy(ref.studyInstanceUID);

  // 2. Series in finding order — what the walk-through actually displays first.
  for (const f of c.findings.slice().sort((a, b) => a.order - b.order)) {
    addStudy(f.studyInstanceUID);
    addSeries(f.seriesInstanceUID);
  }

  // 3. Any remaining series declared on studyRefs but not yet referenced.
  for (const ref of orderedStudyRefs(c)) {
    for (const s of ref.seriesInstanceUIDs ?? []) addSeries(s);
  }

  return { studyUIDs, seriesOrder };
}
