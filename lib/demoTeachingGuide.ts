/**
 * Demo teach scripts for cases that have findings but no teacher recording.
 *
 * The script is `buildTeachingGuide`: sparse anchors (slice, window, lean-in,
 * point) plus the finding's description and teaching points. Say lines are
 * that function's attending acts. This module does not write its own speech.
 *
 * Nothing here stores a RecordedTrack. The first human recording does, and
 * `resolveTeachingGuide` then rebuilds from that track.
 */

import { DEFAULT_ORG_ID } from "./cases";
import { secondaryAnchor } from "./findingAnchors";
import { getPublicCaseTemplate } from "./publicCases/catalog";
import { buildTeachingGuide, teacherTrackPresent } from "./teachingGuide";
import type {
  Case,
  Finding,
  FindingAnchor,
  RecordedEvent,
  RecordedTrack,
  TeachingGuide,
} from "./types";

export const LIDC_CASE_ID = "case-lidc-nodule-search";

/**
 * Image count of the public LIDC-IDRI series in the catalog. sliceAt() anchors
 * are written against this height, then import scales by the highest template
 * slice, which lands the three findings on 34 / 6 / 64 (6 is the reader-
 * annotated left apical nodule).
 */
export const LIDC_STACK_SLICES = 65;

/** Magnification passed to buildTeachingGuide as the lean-in anchor. */
export const DEMO_LEAN_IN_ZOOM = 2.2;

/**
 * How many slices above the nodule survey the compare pane opens.
 * The public LIDC case has one series. This adjacent slice is the demo that
 * Compare is not a second copy of the primary landing. Two slices stays inside
 * the case prefetch radius around the nodule.
 */
export const LIDC_COMPARE_SLICE_DELTA = 2;

type GuideInput = Partial<Finding> &
  Pick<Finding, "label" | "description" | "teachingPoints" | "marker"> & {
    sliceIndex?: number;
    windowWidth?: number;
    windowCenter?: number;
    order?: number;
    seriesInstanceUID?: string;
  };

export function findingHasTeacherTrack(finding: { track?: Finding["track"] }): boolean {
  return teacherTrackPresent(finding);
}

/** Scale catalog slice indices onto the imported stack. */
export function scaleTemplateSlices<T extends { sliceIndex?: number }>(
  findings: T[],
  instanceCount: number
): T[] {
  if (instanceCount <= 1) return findings;
  const templateMax = Math.max(...findings.map((finding) => finding.sliceIndex ?? 0), 1);
  return findings.map((finding) => {
    const t = finding.sliceIndex ?? 0;
    const scaled = Math.round((t / templateMax) * (instanceCount - 1));
    return { ...finding, sliceIndex: Math.max(0, Math.min(instanceCount - 1, scaled)) };
  });
}

/**
 * A clock whose settled end is the committed landing. Used only as input to
 * `buildTeachingGuide`. It is not saved on the finding.
 */
function anchorTrack(finding: GuideInput): RecordedTrack {
  const slice = finding.sliceIndex ?? 0;
  const order = finding.order ?? 1;
  const ww = finding.windowWidth;
  const wc = finding.windowCenter;
  const startSlice = order <= 1 ? 0 : Math.max(0, slice - 8);
  const startWw = order <= 1 ? 400 : ww;
  const startWc = order <= 1 ? 40 : wc;
  const events: RecordedEvent[] = [];
  if (finding.seriesInstanceUID) {
    events.push({ t: 0, type: "series", seriesInstanceUID: finding.seriesInstanceUID });
  }
  events.push({ t: 200, type: "slice", index: slice });
  if (ww != null && wc != null && Number.isFinite(ww) && Number.isFinite(wc)) {
    events.push({ t: 600, type: "voi", ww, wc });
  }
  events.push({ t: 1000, type: "camera", zoom: DEMO_LEAN_IN_ZOOM, pan: [0, 0] });
  events.push({
    t: 1400,
    type: "cursor",
    x: finding.marker.x_pct,
    y: finding.marker.y_pct,
  });
  return {
    durationMs: 1600,
    start: { sliceIndex: startSlice, ww: startWw, wc: startWc },
    events,
  };
}

/**
 * Attending script for one LIDC finding. Speech and act order come from
 * `buildTeachingGuide`.
 */
export function buildLidcDemoGuide(finding: GuideInput): TeachingGuide {
  if (finding.sliceIndex == null || !Number.isFinite(finding.sliceIndex)) {
    throw new Error("LIDC demo guide needs a sliceIndex.");
  }
  if (!finding.marker) throw new Error("LIDC demo guide needs a marker.");
  return buildTeachingGuide(anchorTrack(finding), {
    anchors: {
      sliceIndex: finding.sliceIndex,
      ww: finding.windowWidth,
      wc: finding.windowCenter,
      zoom: DEMO_LEAN_IN_ZOOM,
      pan: [0, 0],
      point: { x: finding.marker.x_pct, y: finding.marker.y_pct },
      label: finding.label,
      description: finding.description,
      teachingPoints: finding.teachingPoints,
    },
  });
}

/**
 * Compare landing for the peripheral nodule survey (order 2).
 * Same series and lung window, two slices above the committed slice, fit camera.
 * Other findings stay single-pane. Returns undefined when the slice cannot move.
 */
export function lidcNoduleCompareAnchors(
  finding: Partial<Finding>
): FindingAnchor[] | undefined {
  if (finding.order !== 2) return undefined;
  if (finding.sliceIndex == null || !Number.isFinite(finding.sliceIndex) || !finding.marker) {
    return undefined;
  }
  const adjacent = Math.max(0, finding.sliceIndex - LIDC_COMPARE_SLICE_DELTA);
  if (adjacent === finding.sliceIndex) return undefined;
  const ww = finding.windowWidth ?? 1500;
  const wc = finding.windowCenter ?? -600;
  const primary: FindingAnchor = {
    studyInstanceUID: finding.studyInstanceUID,
    seriesInstanceUID: finding.seriesInstanceUID,
    sliceIndex: finding.sliceIndex,
    windowWidth: ww,
    windowCenter: wc,
    marker: finding.marker,
    viewportRole: "primary",
    studyRole: "current",
  };
  const secondary: FindingAnchor = {
    studyInstanceUID: finding.studyInstanceUID,
    seriesInstanceUID: finding.seriesInstanceUID,
    sliceIndex: adjacent,
    windowWidth: ww,
    windowCenter: wc,
    zoom: 1,
    pan: [0, 0],
    marker: finding.marker,
    viewportRole: "secondary",
    studyRole: "current",
  };
  return [primary, secondary];
}

function withLidcCompareLanding<T extends Partial<Finding>>(finding: T): T {
  const anchors = lidcNoduleCompareAnchors(finding);
  if (!anchors) return finding;
  return { ...finding, anchors };
}

/** Attach the demo guide unless a teacher track already owns the finding. */
export function attachDemoTeachingGuide<T extends Partial<Finding>>(finding: T): T {
  if (findingHasTeacherTrack(finding)) return finding;
  if (finding.sliceIndex == null || !finding.marker || !finding.label?.trim()) return finding;
  return {
    ...finding,
    teachingGuide: buildLidcDemoGuide(finding as GuideInput),
  };
}

function authoredRubricPresent(finding: Partial<Finding>): boolean {
  if (finding.reportGold?.trim()) return true;
  return (finding.reportMustMention ?? []).some((phrase) => phrase.trim());
}

/**
 * Catalog report gold to copy onto a finding that has none.
 * A non-empty `reportGold` or `reportMustMention` is left alone.
 * Returns null when there is nothing to copy.
 */
export function missingReportRubric(
  finding: Partial<Finding>,
  source: Partial<Finding> | undefined
): Partial<Pick<Finding, "reportGold" | "reportMustMention">> | null {
  if (!source || authoredRubricPresent(finding)) return null;
  const reportGold = source.reportGold?.trim() ?? "";
  const reportMustMention = (source.reportMustMention ?? [])
    .map((phrase) => phrase.trim())
    .filter(Boolean);
  if (!reportGold && reportMustMention.length === 0) return null;
  return {
    ...(reportGold ? { reportGold } : {}),
    ...(reportMustMention.length ? { reportMustMention } : {}),
  };
}

function mergeMissingReportRubric<T extends Partial<Finding>>(
  finding: T,
  source: Partial<Finding> | undefined
): T {
  const patch = missingReportRubric(finding, source);
  if (!patch) return finding;
  return { ...finding, ...patch };
}

/**
 * Patch applied when `seed:lidc-teach` revisits a stored LIDC finding.
 * Report gold comes from the catalog and is filled only when the finding
 * has neither field. A teacher track is not replaced. The demo guide is
 * attached only when that track is absent and the finding can host one.
 */
export function lidcReseedPatch(finding: Finding): Partial<Finding> | null {
  const template = getPublicCaseTemplate(LIDC_CASE_ID);
  const source = template?.findings.find((item) => item.order === finding.order);
  const rubric = missingReportRubric(finding, source);
  if (findingHasTeacherTrack(finding) || finding.sliceIndex == null || !finding.marker) {
    return rubric;
  }
  const patch: Partial<Finding> = {
    ...(rubric ?? {}),
    teachingGuide: buildLidcDemoGuide(finding),
  };
  const anchors = lidcNoduleCompareAnchors(finding);
  if (anchors && !secondaryAnchor(finding)) patch.anchors = anchors;
  return patch;
}

/**
 * Findings to keep vs create on import. Only the LIDC case receives a demo
 * guide, and only for findings that do not yet have a teacher track.
 * A kept track still receives catalog report gold when it has none.
 */
export function planPublicCaseFindings(
  caseId: string,
  findings: Array<Omit<Finding, "id"> & Partial<Finding>>,
  instanceCount: number,
  existing: Finding[] = []
): { kept: Finding[]; create: Array<Omit<Finding, "id"> & Partial<Finding>> } {
  const scaled = scaleTemplateSlices(findings, instanceCount);
  if (caseId !== LIDC_CASE_ID) return { kept: [], create: scaled };
  const kept: Finding[] = [];
  const create: Array<Omit<Finding, "id"> & Partial<Finding>> = [];
  for (const draft of scaled) {
    const prior = existing.find((finding) => finding.order === draft.order);
    if (prior && findingHasTeacherTrack(prior)) {
      kept.push(mergeMissingReportRubric(prior, draft));
      continue;
    }
    create.push(withLidcCompareLanding(attachDemoTeachingGuide(draft)));
  }
  return { kept, create };
}

const SEED_STAMP = "2026-01-01T00:00:00.000Z";

/** Catalog case with demo guides scaled to the public 65-slice stack. */
export function buildLidcSeedCase(): Case & { id: string } {
  const template = getPublicCaseTemplate(LIDC_CASE_ID);
  if (!template) throw new Error(`Missing public case template ${LIDC_CASE_ID}.`);
  const planned = planPublicCaseFindings(LIDC_CASE_ID, template.findings, LIDC_STACK_SLICES);
  const findings: Finding[] = planned.create.map((finding) => ({
    ...(finding as Omit<Finding, "id">),
    id: `f_${LIDC_CASE_ID.replace(/-/g, "").slice(0, 10)}_${finding.order ?? 1}`,
  }));
  return {
    id: template.caseId,
    caseId: template.caseId,
    title: template.title,
    modality: template.modality,
    pacsbinBaseUrl: "/cornerstone",
    findings,
    orgId: DEFAULT_ORG_ID,
    patientId: template.patientId,
    status: "published",
    specialty: template.specialty,
    difficulty: template.difficulty,
    system: template.system,
    tags: template.tags,
    authorId: "auth_demo",
    studyRefs: [
      {
        studyInstanceUID: template.source.studyInstanceUID,
        seriesInstanceUIDs: [template.source.seriesInstanceUID],
        role: "current",
        order: 0,
      },
    ],
    clinicalHistory: template.clinicalHistory,
    technique: template.technique,
    primaryDiagnosis: template.primaryDiagnosis,
    differentials: template.differentials,
    targetLevel: template.targetLevel,
    learningObjectives: template.learningObjectives,
    discussion: template.discussion,
    references: template.references,
    createdAt: SEED_STAMP,
    updatedAt: SEED_STAMP,
  };
}
