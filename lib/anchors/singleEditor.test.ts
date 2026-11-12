import test from "node:test";
import assert from "node:assert/strict";
import { assembleRecordedFinding } from "../../components/author/lib";
import { markerTrack } from "./fixtures";
import { resolveAnchor } from "./resolve";
import type { Finding } from "../types";
const base: Partial<Finding> = { label: "Synthetic", description: "Synthetic notes", teachingPoints: [], state: " " };
test("single-finding caller refuses silent collapse before any media request, and explicit grouping retains all IDs", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("No network in single-editor test"); });
  const track = markerTrack();
  await assert.rejects(assembleRecordedFinding(base, track, { base64: "c3ludGhldGlj", mimeType: "audio/wav" }), /explicit grouping/);
  assert.equal(calls, 0);
  const grouped = await assembleRecordedFinding(base, track, null, undefined, true);
  assert.equal(grouped.finding.groupedAnchors!.length, 3);
  assert.deepEqual(grouped.finding.markerReconciliation!.markerIds, ["marker-0", "marker-1", "marker-2"]);
  assert.equal(calls, 0);
});
test("single retained marker overrides cursor suggestions with the same resolved image as preview", async () => {
  const track = markerTrack(); track.journal = track.journal!.slice(0, 2);
  const result = await assembleRecordedFinding({ ...base, sopInstanceUID: "9.9.9", marker: { x_pct: .99, y_pct: .99, shape: "circle" } }, track, null);
  assert.deepEqual(result.finding.resolvedAnchor, resolveAnchor("marker-0", track.journal));
  assert.equal(result.finding.sopInstanceUID, "1.2.3.4"); assert.equal(result.finding.frameNumber, 1);
});
