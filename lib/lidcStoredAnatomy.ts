import { LIDC_ANCHOR_SOPS } from "./publicCases/catalog";
import { teacherTrackPresent } from "./teachingGuide";
import type { Finding, FindingAnchor, Marker, TeachingGuide } from "./types";

/**
 * The LIDC teach case was stored on staging before its slices were anatomy.
 * `seedIfEmpty` does not rewrite an existing document, so that copy still has
 * the placeholder indices and no SOP:
 *   finding 1 at 34 (heart), finding 2 at 49 with compare 47 (upper abdomen),
 *   finding 3 at 64 (kidneys).
 * On the position-sorted stack those are the wrong images. The committed seed
 * names the carina, the left apical nodule and the hila. A read rebinds only
 * that placeholder fingerprint. An author track, an existing SOP, an approval,
 * or any other slice is left as stored. Nothing here writes the document.
 */

const LIDC_CASE_ID = "case-lidc-nodule-search";

const MARKER = {
  carina: { x_pct: 0.54, y_pct: 0.52, shape: "circle" },
  nodule: { x_pct: 0.68, y_pct: 0.494, shape: "circle" },
  hila: { x_pct: 0.52, y_pct: 0.44, shape: "circle" },
} as const satisfies Record<string, Marker>;

interface Canon {
  order: number;
  staleSlice: number;
  sliceIndex: number;
  sopInstanceUID: string;
  marker: Marker;
  windowWidth: number;
  windowCenter: number;
  guideStart: number;
  compare?: { sliceIndex: number; sopInstanceUID: string };
}

const CANON: readonly Canon[] = [
  {
    order: 1,
    staleSlice: 34,
    sliceIndex: 20,
    sopInstanceUID: LIDC_ANCHOR_SOPS.carina,
    marker: MARKER.carina,
    windowWidth: 1500,
    windowCenter: -600,
    guideStart: 0,
  },
  {
    order: 2,
    staleSlice: 49,
    sliceIndex: 6,
    sopInstanceUID: LIDC_ANCHOR_SOPS.nodule,
    marker: MARKER.nodule,
    windowWidth: 1500,
    windowCenter: -600,
    guideStart: 0,
    compare: { sliceIndex: 5, sopInstanceUID: LIDC_ANCHOR_SOPS.aboveNodule },
  },
  {
    order: 3,
    staleSlice: 64,
    sliceIndex: 22,
    sopInstanceUID: LIDC_ANCHOR_SOPS.hila,
    marker: MARKER.hila,
    windowWidth: 400,
    windowCenter: 40,
    guideStart: 14,
  },
];

function retargetGuide(guide: TeachingGuide, canon: Canon): TeachingGuide {
  return {
    ...guide,
    start: { ...guide.start, sliceIndex: canon.guideStart },
    beats: guide.beats.map((beat) => ({
      ...beat,
      actions: beat.actions.map((action) => {
        if (action.type === "scroll" && action.sliceIndex === canon.staleSlice) {
          return { ...action, sliceIndex: canon.sliceIndex };
        }
        if (action.type === "point") return { ...action, x: canon.marker.x_pct, y: canon.marker.y_pct };
        return action;
      }),
    })),
  };
}

function landing(finding: Finding, canon: Canon, sliceIndex: number, sopInstanceUID: string): FindingAnchor {
  return {
    studyInstanceUID: finding.studyInstanceUID,
    seriesInstanceUID: finding.seriesInstanceUID,
    sopInstanceUID,
    sliceIndex,
    windowWidth: canon.windowWidth,
    windowCenter: canon.windowCenter,
    marker: canon.marker,
    viewportRole: "primary",
    studyRole: "current",
  };
}

function retargetAnchors(finding: Finding, canon: Canon): FindingAnchor[] | undefined {
  if (!finding.anchors?.length && !canon.compare) return finding.anchors;
  const primary = landing(finding, canon, canon.sliceIndex, canon.sopInstanceUID);
  const secondary = canon.compare
    ? {
        ...landing(finding, canon, canon.compare.sliceIndex, canon.compare.sopInstanceUID),
        zoom: 1 as const,
        pan: [0, 0] as [number, number],
        viewportRole: "secondary" as const,
      }
    : undefined;
  if (!finding.anchors?.length) return secondary ? [primary, secondary] : undefined;
  let sawSecondary = false;
  const next = finding.anchors.map((anchor) => {
    const isSecondary = anchor.viewportRole === "secondary" || anchor.viewportRole === "compare";
    if (isSecondary && secondary) {
      sawSecondary = true;
      return { ...anchor, ...secondary };
    }
    if (!isSecondary) return { ...anchor, ...primary };
    return anchor;
  });
  if (secondary && !sawSecondary) next.push(secondary);
  return next;
}

function rebindFinding(finding: Finding): Finding {
  if (finding.approvedVersion != null || teacherTrackPresent(finding) || finding.sopInstanceUID?.trim()) {
    return finding;
  }
  const canon = CANON.find((item) => item.order === finding.order && item.staleSlice === finding.sliceIndex);
  if (!canon) return finding;
  const measurements =
    canon.order === 2
      ? [
          {
            id: "m_lidc_n2",
            kind: "ellipse" as const,
            sopInstanceUID: canon.sopInstanceUID,
            sliceIndex: canon.sliceIndex,
            handles: [
              [0.6751, 0.4873],
              [0.6849, 0.501],
            ] as Array<[number, number]>,
            label: "LIDC reader extent",
          },
        ]
      : finding.measurements;
  return {
    ...finding,
    sopInstanceUID: canon.sopInstanceUID,
    sliceIndex: canon.sliceIndex,
    marker: canon.marker,
    windowWidth: canon.windowWidth,
    windowCenter: canon.windowCenter,
    teachingGuide: finding.teachingGuide ? retargetGuide(finding.teachingGuide, canon) : finding.teachingGuide,
    anchors: retargetAnchors(finding, canon),
    measurements,
  };
}

/** In-memory correction of the known stale LIDC placeholders. Same object when nothing moves. */
export function rebindStaleLidcCase<T extends { caseId?: string; findings?: Finding[] }>(data: T): T {
  if (data.caseId !== LIDC_CASE_ID || !data.findings) return data;
  let changed = false;
  const findings = data.findings.map((finding) => {
    const next = rebindFinding(finding);
    if (next !== finding) changed = true;
    return next;
  });
  return changed ? { ...data, findings } : data;
}
