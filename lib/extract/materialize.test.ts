import test from "node:test";
import assert from "node:assert/strict";
import { materializeExtraction } from "./materialize";
import { markerTrack, plane } from "../anchors/fixtures";
import { geometryFromDicom } from "../anchors/geometry";
import { newManifest } from "../journal/manifest";
import type { CaptureSession } from "../types";
import type { ExtractProposal } from "./schema";
const metadata = { requestedModel: "gemini-3.8-flash", responseModelVersion: null, apiSurface: "generateContent" as const, configHash: "synthetic" };
function fixture() {
  const track = markerTrack();
  const session: CaptureSession = { id: "take", createdAt: "synthetic", durationMs: 1000, track, journal: track.journal,
    manifest: { ...newManifest("case", "take"), status: "complete", durationMs: 1000, phiReview: { pixels: true, audio: true, screen: true }, chunks: [{ seq: 0, stream: "video", tStart: 0, tEnd: 1000, bytes: 4, mime: "video/webm", sha256: "a".repeat(64) }] } };
  const proposals: ExtractProposal[] = [0, 1, 2].map(i => ({ label: "Synthetic", description: "Contour", teachingPoints: [], dictatedOrVisual: "visual", confidence: .9, markerId: `marker-${i}`, evidence: [{ tStart: i * 100, tEnd: i * 100 + 60, journalSeq: [i * 2, i * 2 + 1] }] }));
  return { session, proposals, run: () => materializeExtraction(session, { id: "job", baseFindings: [] }, proposals, metadata) };
}
test("M6 rough windows require unambiguous retained marker evidence; reversed/outside references stay unresolved", () => {
  const f = fixture();
  f.proposals[0].markerId = undefined; f.proposals[0].evidence[0] = { tStart: 0, tEnd: 150, journalSeq: [0, 1, 2, 3] };
  f.proposals.splice(1, 1); // one rough window covers two retained markers
  let drafts = f.run(); assert.ok(drafts.slice(0, 2).every(d => d.issues.includes("ambiguous_marker_window")));
  const g = fixture(); g.proposals[0].evidence[0] = { tStart: 50, tEnd: 0, journalSeq: [1] };
  g.proposals[1].evidence[0] = { tStart: 101, tEnd: 160, journalSeq: [2, 3] };
  g.proposals[2].evidence[0].journalSeq = [4];
  drafts = g.run(); assert.ok(drafts[0].issues.includes("invalid_interval")); assert.ok(drafts[1].issues.includes("journal_outside_interval")); assert.ok(drafts[2].issues.includes("marker_evidence_missing"));
  assert.equal(g.proposals[0].evidence[0].tEnd, 0);
});
test("M6 discontinuities and unacknowledged markers cannot become ground truth", () => {
  const f = fixture(); f.session.journal!.push({ seq: 6, t: 250, kind: "discontinuity", payload: { reason: "synthetic gap" } });
  f.session.journal![1].renderSeq = 999;
  const drafts = f.run();
  assert.ok(drafts[0].issues.includes("unresolved_anchor")); assert.ok(drafts[2].issues.includes("discontinuous_interval"));
  assert.ok(drafts[0].finding.anchor === undefined && drafts[2].finding.anchor === undefined);
});
test("M6 referenced native measurements retain spacing and named SOP/frame; removed annotations stay removed", () => {
  const f = fixture(), render = f.session.journal![0];
  const annotation = { seq: 2, t: 30, kind: "annotation" as const, renderSeq: render.renderSeq, snapshot: render.snapshot,
    payload: { annotationId: "length", event: { type: "annotation", tool: "Length", lengthMm: 999 }, dimensions: [64, 64], imagePoints: [{ x: 10, y: 20 }, { x: 20, y: 20 }], geometry: geometryFromDicom(plane, 1) } };
  f.session.track.journal = f.session.journal = [render, f.session.journal![1], annotation]; f.proposals = [f.proposals[0]];
  f.proposals[0].evidence[0].journalSeq.push(2);
  const run = () => materializeExtraction(f.session, { id: "job", baseFindings: [] }, f.proposals, metadata);
  const m = run()[0].finding.measurements![0];
  assert.equal(m.lengthMm, 9); assert.equal(m.frameNumber, 1); assert.equal(m.sopInstanceUID, render.snapshot!.sopUID); assert.equal(m.resolvedAnchor!.calibration, "PixelSpacing");
  f.session.journal.push({ ...annotation, seq: 3, t: 40, payload: { annotationId: "length", action: "remove" } });
  assert.deepEqual(run()[0].finding.measurements, []);
});
