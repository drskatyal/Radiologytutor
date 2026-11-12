import test from "node:test";
import assert from "node:assert/strict";
import { reconcileMarkers, reconcileDrafts } from "./reconcile";
import { notesDrafts } from "./notes";
import { markerTrack } from "./fixtures";
import { mergeCaptureDemonstration } from "../harness/mergeCapture";
import { findingsFromCompiledTake } from "../liveTeachingPack";
const text = [{ label: "Synthetic finding", description: "Synthetic description", teachingPoints: [], tStartMs: 0, tEndMs: 1000 }];
test("T7 three silent markers produce three notes, segmented and AI candidates with distinct SOPs", () => {
  const track = markerTrack();
  const notes = notesDrafts(track);
  const segmented = mergeCaptureDemonstration({ sessionId: "take", parentTrack: track, segments: text }).findings;
  const ai = findingsFromCompiledTake({ captureSessionId: "take", track, drafted: text });
  for (const result of [notes, segmented, ai]) {
    assert.equal(result.length, 3);
    assert.deepEqual(result.map(f => f.markerId), ["marker-0", "marker-1", "marker-2"]);
    assert.deepEqual(result.map(f => f.resolvedAnchor!.snapshot!.sopUID), ["1.2.3.4", "1.2.3.5", "1.2.3.6"]);
    assert.ok(result.every(f => f.resolvedAnchor!.anchorStatus === "resolved"));
  }
});
test("retained markers honor undo, removal and moves, without resurrecting model marker IDs", () => {
  const track = markerTrack();
  track.journal!.push({ seq: 6, t: 400, kind: "marker", payload: { action: "undo", markerId: "marker-2" } }, { seq: 7, t: 500, kind: "marker", payload: { action: "remove", markerId: "marker-0" } });
  const result = reconcileDrafts(track, [{ ...text[0], markerId: "marker-2" }]);
  assert.equal(result.length, 1); assert.equal(result[0].markerId, "marker-1");
  assert.equal(result[0].label, "Finding 1");
});
test("explicit grouping of two gives two drafts, preserves both anchors and records omission decisions", () => {
  const track = markerTrack();
  const markerDecisions = [{ kind: "group" as const, markerIds: ["marker-0", "marker-1"], reason: "Two views of one synthetic finding" }];
  const findings = findingsFromCompiledTake({ captureSessionId: "take", track, drafted: text, markerDecisions });
  assert.equal(findings.length, 2); assert.deepEqual(findings[0].markerReconciliation, markerDecisions[0]); assert.equal(findings[0].groupedAnchors!.length, 2);
  const omitted = { kind: "omit" as const, markerIds: ["marker-2"], reason: "Accidental click" };
  const reconciled = reconcileMarkers(track.journal!, [...markerDecisions, omitted]);
  assert.equal(reconciled.drafts.length, 1); assert.deepEqual(reconciled.omitted, [omitted]);
  for (const decisions of [[{ ...omitted, reason: "" }], [{ ...omitted, markerIds: ["foreign"] }], [omitted, omitted]]) assert.throws(() => reconcileMarkers(track.journal!, decisions), /reconciliation/);
});
test("cursor midpoint is only an unresolved suggestion; no final live SOP becomes authoritative", () => {
  const track = { start: { sliceIndex: 0 }, events: [{ type: "cursor" as const, t: 100, x: 0.5, y: 0.5 }], durationMs: 1000 };
  const findings = mergeCaptureDemonstration({ sessionId: "take", parentTrack: track, segments: text, sopInstanceUID: "1.2.999" }).findings;
  assert.equal(findings[0].resolvedAnchor!.anchorStatus, "unresolved"); assert.equal(findings[0].anchor, undefined);
  assert.equal(findingsFromCompiledTake({ captureSessionId: "take", track, drafted: text })[0].anchorStatus, "unresolved");
});

test("undoing every marker never resurrects an omitted marker from returned model prose", () => {
  const track = markerTrack();
  for (let i = 0; i < 3; i++) track.journal!.push({ seq: 6 + i, t: 500, kind: "marker", payload: { action: "undo", markerId: `marker-${i}` } });
  assert.deepEqual(reconcileDrafts(track, [{ ...text[0], markerId: "marker-1" }]), []);
  assert.deepEqual(notesDrafts(track), []);
});
