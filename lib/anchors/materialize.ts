import type { Finding, RecordedTrack } from "../types";
import type { MarkerAssignment } from "./reconcile";
import { resolveAnchor, type ResolvedAnchor } from "./resolve";

/** No live viewport state and no model geometry can enter these fields. */
export function anchorFields(track: RecordedTrack, assignment: Partial<MarkerAssignment>): Partial<Finding> {
  const a = resolveAnchor(assignment.markerId, track.journal ?? []);
  const groupedAnchors = (assignment.markerIds ?? []).map(id => resolveAnchor(id, track.journal ?? []));
  const base: Partial<Finding> = { anchorStatus: groupedAnchors.some(g => g.anchorStatus !== "resolved") ? "unresolved" : a.anchorStatus, resolvedAnchor: a, markerId: assignment.markerId,
    ...(assignment.reconciliation ? { markerReconciliation: assignment.reconciliation, groupedAnchors } : {}) };
  if (a.anchorStatus !== "resolved" || !a.snapshot || !a.imagePoint || !a.dimensions) return base;
  const s = a.snapshot;
  const render = track.journal?.find(e => e.seq === a.journalSeq[0]);
  const index = render?.payload?.displayIndex;
  return { ...base, studyInstanceUID: s.studyUID, seriesInstanceUID: s.seriesUID, sopInstanceUID: s.sopUID, frameNumber: s.frame,
    imagePoint: a.imagePoint, marker: { shape: "circle", x_pct: a.imagePoint.x / (a.dimensions[0] - 1), y_pct: a.imagePoint.y / (a.dimensions[1] - 1) },
    anchor: { studyUID: s.studyUID, seriesUID: s.seriesUID, sopUID: s.sopUID, frame: s.frame, imagePoint: a.imagePoint, view: { ww: s.voi.ww, wc: s.voi.wc, ...s.camera, invert: s.invert } },
    windowWidth: s.voi.ww, windowCenter: s.voi.wc,
    ...(typeof index === "number" ? { sliceIndex: index } : {}),
    evidence: [{ tStart: track.journal?.find(e => e.seq === a.journalSeq.at(-1))?.t ?? 0, tEnd: track.journal?.find(e => e.seq === a.journalSeq.at(-1))?.t ?? 0, journalSeq: a.journalSeq }],
    anchors: (groupedAnchors.length ? groupedAnchors : [a]).filter((g): g is ResolvedAnchor & { snapshot: NonNullable<ResolvedAnchor["snapshot"]> } => g.anchorStatus === "resolved" && !!g.snapshot).map(g => ({ studyInstanceUID: g.snapshot.studyUID, seriesInstanceUID: g.snapshot.seriesUID, sopInstanceUID: g.snapshot.sopUID, frameNumber: g.snapshot.frame, windowWidth: g.snapshot.voi.ww, windowCenter: g.snapshot.voi.wc, viewportRole: "primary", studyRole: "current" })),
  };
}
