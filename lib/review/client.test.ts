import test from "node:test";
import assert from "node:assert/strict";
import { jumpToReview, captureReviewPoint } from "./client";
import { annotationSummary, evidenceMediaTime } from "./model";
import { journalTestView } from "../journal/fixtures";
import type { FindingReviewState } from "./model";
import type { RenderConfirmedViewer } from "../viewerController";
const row = { snapshot: journalTestView, anchorStatus: "resolved" } as FindingReviewState;
test("M7 jump waits for a matching ack; wrong identity and superseded responses never confirm", async () => {
  let release!: () => void, confirmed = false;
  const held = new Promise<void>(r => { release = r; });
  const wait = jumpToReview({ requestView: async command => { await held; return { ...command, at: 0 }; } }, row).then(() => { confirmed = true; });
  await Promise.resolve(); assert.equal(confirmed, false); release(); await wait; assert.equal(confirmed, true);
  await assert.rejects(jumpToReview({ requestView: async command => ({ ...command, at: 0, snapshot: { ...journalTestView, frame: 2 } }) }, row), /superseded/);
  await assert.rejects(jumpToReview({ requestView: async () => { throw Object.assign(new Error("missing"), { code: "missing_identity" }); } }, row), /Image not found: rebind/);
  let calls = 0;
  await assert.rejects(jumpToReview({ requestView: async () => { calls++; throw new Error(); } }, { ...row, anchorStatus: "legacy_index", snapshot: null })); assert.equal(calls, 0);
});
test("M7 rebind requires the currently acknowledged render; evidence seek applies offsets without fabricating pre-stream time", () => {
  const evidence = { snapshot: journalTestView, imagePoint: { x: 20, y: 20 }, dimensions: [64, 64] as [number, number] };
  const viewer: Partial<RenderConfirmedViewer> = { captureImagePoint: () => evidence, getRenderedView: () => ({ snapshot: journalTestView, at: 0 }) };
  assert.deepEqual(captureReviewPoint(viewer), evidence);
  assert.throws(() => captureReviewPoint({ ...viewer, getRenderedView: () => ({ snapshot: { ...journalTestView, renderSeq: 99 }, at: 0 }) }), /Wait for/);
  assert.equal(evidenceMediaTime(1500, 500, 3000), 1); assert.equal(evidenceMediaTime(100, 500, 3000), null); assert.equal(evidenceMediaTime(3100, 0, 3000), null);
});


test("M7 annotation calibration badges require their own resolved image evidence", () => {
  assert.deepEqual(annotationSummary({ label: "Legacy annotation" }), { label: "Legacy annotation", calibration: "uncalibrated", frame: null });
  const resolvedAnchor = { anchorStatus: "resolved", snapshot: journalTestView, calibration: "ImagerPixelSpacing" };
  assert.deepEqual(annotationSummary({ label: "Calibrated annotation", resolvedAnchor }), { label: "Calibrated annotation", calibration: "ImagerPixelSpacing", frame: journalTestView.frame });
  assert.equal(annotationSummary({ resolvedAnchor: { ...resolvedAnchor, anchorStatus: "unresolved" } }).calibration, "uncalibrated");
});
