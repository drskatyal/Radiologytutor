import test from "node:test";
import assert from "node:assert/strict";
import { resolveAnchor } from "./resolve";
import { markerTrack } from "./fixtures";
import { findingsFromCompiledTake } from "../liveTeachingPack";
import { mergeCaptureDemonstration } from "../harness/mergeCapture";
import { hashContent, findingContent } from "../findingContent";
test("preview, notes/segmented materialization and server AI anchors are deeply equal", () => {
  const track = markerTrack(); const drafted = [{ label: "Synthetic", description: "", teachingPoints: [], tStartMs: 0, tEndMs: 1000 }];
  const segmented = mergeCaptureDemonstration({ sessionId: "take", parentTrack: track, segments: drafted }).findings;
  const ai = findingsFromCompiledTake({ captureSessionId: "take", track, drafted });
  ai.forEach((f, i) => {
    const preview = resolveAnchor(`marker-${i}`, track.journal!);
    assert.deepEqual(f.resolvedAnchor, preview); assert.deepEqual(segmented[i].resolvedAnchor, preview);
    const hash = hashContent(findingContent(f)); const moved = structuredClone(f);
    moved.resolvedAnchor!.geometry.spacing = [0.8, 0.9];
    assert.notEqual(hashContent(findingContent(moved)), hash);
  });
});
test("missing/removed identity, unacknowledged render, out-of-image and MPR fail closed", () => {
  for (const change of ["missing", "render", "pixel", "mpr", "removed"]) {
    const track = markerTrack(); const e = track.journal![1];
    if (change === "missing") e.snapshot = undefined;
    if (change === "render") track.journal!.splice(0, 1);
    if (change === "pixel") e.payload!.imagePoint = { x: 1000, y: 20 };
    if (change === "mpr") e.snapshot = { ...e.snapshot!, layout: "mpr" };
    if (change === "removed") track.journal!.push({ seq: 6, t: 500, kind: "marker", payload: { action: "remove", markerId: "marker-0" } });
    assert.equal(resolveAnchor("marker-0", track.journal!).anchorStatus, change === "missing" ? "legacy_index" : "unresolved");
  }
  assert.equal(resolveAnchor("invented", markerTrack().journal!).anchorStatus, "unresolved");
});

test("group with an unresolved member cannot supply an approvable primary anchor", async () => {
  const { anchorFromFinding } = await import("../findingContent");
  const track = markerTrack(); track.journal![3].payload!.imagePoint = { x: 10000, y: 0 };
  const [f] = findingsFromCompiledTake({ captureSessionId: "take", track, drafted: [], markerDecisions: [{ kind: "group", markerIds: ["marker-0", "marker-1"], reason: "Explicit group" }] });
  assert.equal(f.anchorStatus, "unresolved"); assert.equal(anchorFromFinding(f), undefined);
});

test("a later render in the same viewport makes an old marker snapshot unresolved; malformed geometry fails closed", () => {
  const track = markerTrack();
  track.journal!.push({ ...structuredClone(track.journal![1]), seq: 6, t: 300, payload: { ...track.journal![1].payload, markerId: "stale-marker" } });
  assert.equal(resolveAnchor("stale-marker", track.journal!).anchorStatus, "unresolved");
  for (const bad of [null, "invalid", { x: NaN, y: 0 }]) {
    track.journal![1].payload!.imagePoints = [bad];
    assert.equal(resolveAnchor("marker-0", track.journal!).anchorStatus, "unresolved");
  }
});

test("single-finding save requires explicit multi-marker grouping and preserves every grouped anchor", async () => {
  const { singleFindingAnchorFields } = await import("./materialize");
  const track = markerTrack();
  assert.throws(() => singleFindingAnchorFields(track), /3 retained markers.*explicit grouping/);
  const grouped = singleFindingAnchorFields(track, true);
  assert.equal(grouped.markerReconciliation!.kind, "group");
  assert.equal(grouped.groupedAnchors!.length, 3);
  assert.deepEqual(grouped.resolvedAnchor, resolveAnchor("marker-0", track.journal!));
  track.journal = track.journal!.slice(0, 2);
  assert.deepEqual(singleFindingAnchorFields(track).resolvedAnchor, resolveAnchor("marker-0", track.journal));
});
