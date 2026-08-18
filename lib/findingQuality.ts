// Finding completeness — authoring quality, not a schema change.
// A finding is teachable when it has a real label and a real marker. Teaching
// points and a slice/SOP landing make it exam-ready. Publish should refuse a
// case with zero teachable findings.

import type { Finding, Marker } from "./types";

export type FindingGap = "label" | "marker" | "teaching" | "slice";

export function isPlacedMarker(marker?: Marker | null): boolean {
  if (!marker) return false;
  return (
    Number.isFinite(marker.x_pct) &&
    Number.isFinite(marker.y_pct) &&
    marker.x_pct >= 0 &&
    marker.x_pct <= 1 &&
    marker.y_pct >= 0 &&
    marker.y_pct <= 1
  );
}

export function findingGaps(finding: Finding): FindingGap[] {
  const gaps: FindingGap[] = [];
  if (!finding.label.trim()) gaps.push("label");
  if (!isPlacedMarker(finding.marker)) gaps.push("marker");
  if (finding.teachingPoints.filter((p) => p.trim()).length === 0) {
    gaps.push("teaching");
  }
  if (finding.sliceIndex == null && !finding.sopInstanceUID) {
    gaps.push("slice");
  }
  return gaps;
}

/** Label + marker: the tutor can land and name it. */
export function isTeachableFinding(finding: Finding): boolean {
  const gaps = findingGaps(finding);
  return !gaps.includes("label") && !gaps.includes("marker");
}

/** Teachable + at least one teaching point. */
export function isExamReadyFinding(finding: Finding): boolean {
  return isTeachableFinding(finding) && !findingGaps(finding).includes("teaching");
}

export interface PublishReadiness {
  ready: boolean;
  teachable: number;
  examReady: number;
  total: number;
  blockers: string[];
}

export function casePublishReadiness(findings: Finding[]): PublishReadiness {
  const teachable = findings.filter(isTeachableFinding).length;
  const examReady = findings.filter(isExamReadyFinding).length;
  const blockers: string[] = [];
  if (findings.length === 0) {
    blockers.push("Capture at least one finding.");
  } else if (teachable === 0) {
    blockers.push("Every finding needs a label and a click marker.");
  }
  if (teachable > 0 && examReady === 0) {
    blockers.push("Add teaching points so the examiner has something to ask.");
  }
  return {
    ready: blockers.length === 0,
    teachable,
    examReady,
    total: findings.length,
    blockers,
  };
}
