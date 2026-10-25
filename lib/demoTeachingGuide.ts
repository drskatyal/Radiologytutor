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

import { getPublicCaseTemplate } from "./publicCases/catalog";
import { buildTeachingGuide } from "./teachingGuide";
import type { Case, Finding, RecordedEvent, RecordedTrack, TeachingGuide } from "./types";
import { DEFAULT_ORG_ID } from "./cases";

export const LIDC_CASE_ID = "case-lidc-nodule-search";

/**
 * Image count of the public LIDC-IDRI series in the catalog. sliceAt() anchors
 * are written against this height, then import scales by the highest template
 * slice, which lands the three findings on 34 / 49 / 64.
 */
export const LIDC_STACK_SLICES = 65;

/** Magnification passed to buildTeachingGuide as the lean-in anchor. */
export const DEMO_LEAN_IN_ZOOM = 2.2;

type GuideInput = Partial<Finding> &
  Pick<Finding, "label" | "description" | "teachingPoints" | "marker"> & {
    sliceIndex?: number;
    windowWidth?: number;
    windowCenter?: number;
    order?: number;
    seriesInstanceUID?: string;
  };

export function findingHasTeacherTrack(finding: { track?: Finding["track"] }): boolean {
  const track = finding.track;
  if (!track) return false;
  return (track.events?.length ?? 0) > 0 || (track.durationMs ?? 0) > 0;
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

/** Attach the demo guide unless a teacher track already owns the finding. */
export function attachDemoTeachingGuide<T extends Partial<Finding>>(finding: T): T {
  if (findingHasTeacherTrack(finding)) return finding;
  if (finding.sliceIndex == null || !finding.marker || !finding.label?.trim()) return finding;
  return {
    ...finding,
    teachingGuide: buildLidcDemoGuide(finding as GuideInput),
  };
}

/**
 * Findings to keep vs create on import. Only the LIDC case receives a demo
 * guide, and only for findings that do not yet have a teacher track.
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
      kept.push(prior);
      continue;
    }
    create.push(attachDemoTeachingGuide(draft));
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
