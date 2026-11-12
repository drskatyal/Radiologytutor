import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Case, Finding } from "../types";
import { snapshot, prepareFinding, approveVersion, appendVersion } from "../findingVersions";
import { inventoryFromMetadata } from "../findingInventory";
import { anchorFromFinding } from "../findingContent";
import { loadApprovedToolContext } from "./approvedToolContext";
import { approvedStackIndex, approvedToolsPrompt, emptyToolContext, resolveApprovedTool, type ApprovedToolContext, type ToolFrame } from "./approvedTools";
import { executeApprovedTool, type ApprovedToolViewer } from "./executeApprovedTool";
import { harnessActionFromCall, HARNESS_VIEWER_TOOLS } from "./tools";
import { livePackTools, materializeLiveTeachingPack, validateLiveToolCall } from "../liveTeachingPack";
import { runTeachingPlan } from "../gemini";

const fixture = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8")) as Case;
const instances = JSON.parse(readFileSync("fixtures/synthetic/study.json", "utf8")).instances as { seriesUID: string; sopUID: string; metadata: any }[];
const rows = instances.filter(i => i.seriesUID === fixture.findings[0].seriesInstanceUID).map(i => i.metadata);
const expert = { id: "synthetic-expert", membershipRole: "author" as const };
function approved(multiframe = false) {
  const instance = multiframe ? instances.at(-1)! : instances[0];
  const metadata = multiframe ? [instance.metadata] : rows;
  const base: Finding = { ...fixture.findings[0], seriesInstanceUID: instance.seriesUID, sopInstanceUID: instance.sopUID, frameNumber: multiframe ? 4 : 1, imagePoint: { x: 16, y: 32 }, phiReview: { pixels: true, audio: true, screen: true } };
  const target = { studyUID: base.studyInstanceUID!, seriesUID: base.seriesInstanceUID!, sopUID: base.sopInstanceUID!, frame: base.frameNumber! };
  base.annotations = [{ ...target, shape: "arrow", from: [0.1, 0.2], to: [0.25, 0.5], handles: [[0.1, 0.2], [0.25, 0.5]], tool: "ArrowAnnotate" }];
  const inventory = inventoryFromMetadata(anchorFromFinding(base)!, metadata);
  const f = { ...prepareFinding(base, {}, inventory), currentVersion: 1, status: "needs_review" as const };
  const version = snapshot(f, 1, expert.id, "2026-11-12");
  const data = approveVersion({ ...fixture, findings: [f], findingVersions: [version], findingApprovals: [] }, f.id, 1, version.contentHash, expert, inventory);
  return { data, metadata, inventory, target };
}
const imageId = (f: ToolFrame) => `wadors:/api/dicomweb/studies/${f.studyUID}/series/${f.seriesUID}/instances/${f.sopUID}/frames/${f.frame}`;
async function setup(multiframe = false) {
  const result = approved(multiframe);
  const context = await loadApprovedToolContext(result.data, async () => result.metadata);
  return { ...result, context, anchorId: context.anchors[0].id, annotationId: context.annotations[0].id };
}

for (const name of ["point_to", "draw_annotation"] as const) {
  test(`${name}: only a current approved ID; even matching numeric coordinates and extra geometry are rejected`, async () => {
    const { context, anchorId, annotationId } = await setup();
    const args = name === "point_to" ? { anchorId } : { annotationId };
    const action = harnessActionFromCall({ name, args }, context);
    assert.equal(action.type, name);
    for (const extra of [{ x_pct: 0.25, y_pct: 0.5 }, { x: 16, y: 32 }, { handles: [[0.1, 0.2]] }, { tool: "Length" }, { findingId: "synthetic-1" }]) {
      assert.deepEqual(harnessActionFromCall({ name, args: { ...args, ...extra } }, context), { type: "none" });
    }
    for (const bad of [{}, { findingId: "synthetic-1" }, { ...args, [name === "point_to" ? "anchorId" : "annotationId"]: "invented" }, { x_pct: 0.25, y_pct: 0.5 }]) {
      assert.deepEqual(harnessActionFromCall({ name, args: bad }, context), { type: "none" });
    }
    assert.deepEqual(harnessActionFromCall({ name, args }), { type: "none" });
    assert.deepEqual(harnessActionFromCall({ name, args }, emptyToolContext()), { type: "none" });
    const declaration = HARNESS_VIEWER_TOOLS.find(t => t.name === name)!;
    assert.deepEqual(Object.keys(declaration.parameters.properties as object), [name === "point_to" ? "anchorId" : "annotationId"]);
  });
}

test("server catalog uses actual metadata frame counts and approved pixel geometry", async () => {
  const { context, anchorId, annotationId, target } = await setup();
  assert.equal(context.series[0].frameCount, rows.length);
  assert.deepEqual(resolveApprovedTool("point_to", { anchorId }, context)?.point, { x: 16 / 63, y: 32 / 63, space: "image" });
  const annotation = resolveApprovedTool("draw_annotation", { annotationId }, context)!;
  assert.deepEqual(annotation.target, target);
  assert.deepEqual(annotation.annotation?.to, [0.25, 0.5]);
  assert.match(anchorId, /\/v1\/[a-f0-9]{64}\/anchor$/);
});

for (const multiframe of [false, true]) {
  test(`scroll bounds are real ${multiframe ? "multiframe" : "single-frame"} bounds and the exact approved frame set`, async () => {
    const { context, anchorId, target } = await setup(multiframe);
    const valid = multiframe ? 3 : 0;
    assert.deepEqual(resolveApprovedTool("scroll_to", { sliceIndex: valid }, context)?.target, target);
    assert.deepEqual(resolveApprovedTool("scroll_to", { anchorId }, context)?.target, target);
    for (const sliceIndex of [-1, 4, 999, 0.5, NaN, Infinity, "0", null, true, undefined]) {
      assert.equal(resolveApprovedTool("scroll_to", { sliceIndex }, context), null, String(sliceIndex));
    }
    assert.equal(resolveApprovedTool("scroll_to", { sliceIndex: multiframe ? 2 : 1 }, context), null, "in-range but unapproved frame");
    assert.equal(resolveApprovedTool("scroll_to", { anchorId, sliceIndex: valid }, context), null, "two conflicting address forms");
    assert.equal(resolveApprovedTool("scroll_to", { sliceIndex: valid, seriesInstanceUID: "foreign" }, context), null);
    assert.equal(resolveApprovedTool("scroll_to", { sliceIndex: valid, frameCount: 1000 }, context), null);
    const wrongCount = structuredClone(context); wrongCount.series[0].frameCount = 1000;
    assert.equal(resolveApprovedTool("scroll_to", { sliceIndex: valid }, wrongCount), null);
    const badFrame = structuredClone(context); badFrame.anchors[0].target.frame = 99;
    assert.equal(resolveApprovedTool("scroll_to", { anchorId }, badFrame), null);
  });
}

test("indexed set_series cannot bypass scroll validation", async () => {
  const { context, anchorId } = await setup();
  const seriesInstanceUID = context.series[0].seriesUID;
  for (const sliceIndex of [-1, 0.9, 4, "0"]) assert.equal(harnessActionFromCall({ name: "set_series", args: { seriesInstanceUID, sliceIndex } }, context).type, "none");
  assert.equal(harnessActionFromCall({ name: "set_series", args: { seriesInstanceUID, sliceIndex: 0 } }).type, "none");
  assert.equal(harnessActionFromCall({ name: "set_series", args: { seriesInstanceUID, sliceIndex: 0 } }, context).type, "set_series");
  assert.equal(resolveApprovedTool("set_series", { anchorId, seriesInstanceUID, ww: 400, wc: 40 }, context)?.anchorId, anchorId);
});

test("T1: reorder changes index, preserves approved ID and SOP; viewer resolves loaded order and multiframe", async () => {
  const { data, context, anchorId, target } = await setup();
  const reordered = await loadApprovedToolContext(data, async () => [...rows].reverse());
  assert.equal(reordered.anchors[0].id, anchorId);
  assert.equal(resolveApprovedTool("scroll_to", { anchorId }, reordered)?.sliceIndex, 3);
  assert.deepEqual(resolveApprovedTool("scroll_to", { anchorId }, reordered)?.target, target);
  assert.equal(approvedStackIndex(target, context.series[0].frames.map(imageId).reverse()), 3);
  const multi = await setup(true);
  assert.equal(approvedStackIndex(multi.target, multi.context.series[0].frames.map(imageId)), 3);
  assert.equal(approvedStackIndex({ ...multi.target, frame: 2 }, multi.context.series[0].frames.map(imageId)), 1);
});

for (const change of ["edit", "tamper", "revoked", "draft", "missing", "legacy", "metadata outage"] as const) {
  test(`T2/T3/T9: ${change} withholds current tool authority without index fallback`, async () => {
    const { data, inventory, anchorId } = await setup();
    let next = structuredClone(data);
    if (change === "edit") next = appendVersion(next, next.findings[0].id, prepareFinding(next.findings[0], { description: "Edited" }, inventory), 1, expert.id);
    if (change === "tamper") next.findings[0].marker.x_pct = 0.9;
    if (change === "revoked") next.findingApprovals![0].revokedAt = "2026-11-12";
    if (change === "draft") next.status = "draft";
    if (change === "legacy") delete next.findings[0].anchor;
    const context = await loadApprovedToolContext(next, async () => { if (change === "metadata outage") throw new Error("Offline"); return change === "missing" ? rows.slice(1) : rows; });
    assert.deepEqual(context, emptyToolContext());
    assert.equal(resolveApprovedTool("scroll_to", { anchorId }, context), null);
  });
}

test("unlocated legacy annotation/guide and out-of-image point never get invented coordinates", async () => {
  const { data, metadata, inventory } = approved();
  const f = data.findings[0];
  const changed = prepareFinding(f, { anchor: { ...f.anchor!, imagePoint: { x: 999, y: 16 } }, annotations: [{ shape: "circle", from: [0, 0], to: [1, 1], sliceIndex: 0 }] }, inventory);
  const updated = appendVersion(data, f.id, changed, 1, expert.id);
  const v = updated.findingVersions!.at(-1)!;
  const current = approveVersion(updated, f.id, v.version, v.contentHash, expert, inventory);
  const context = await loadApprovedToolContext(current, async () => metadata);
  assert.equal(context.anchors[0].point, undefined, "invalid explicit pixel point cannot fall back to marker");
  assert.deepEqual(context.annotations, []);
  assert.equal(resolveApprovedTool("point_to", { anchorId: context.anchors[0].id }, context), null);
});

test("Live and REST share catalog/strict validation, examiner receives none", async () => {
  const { data, context, anchorId, annotationId } = await setup();
  const pack = materializeLiveTeachingPack({ caseId: data.caseId, modality: data.modality, findings: data.findings });
  for (const [name, args] of [["point_to", { anchorId }], ["draw_annotation", { annotationId }], ["scroll_to", { sliceIndex: 0 }]] as [string, Record<string, unknown>][]) {
    const decision = validateLiveToolCall(pack, name, args, undefined, undefined, context);
    assert.equal(decision.ok, true);
    if (decision.ok) assert.deepEqual(decision.approvedAction, harnessActionFromCall({ name, args }, context));
    assert.equal(validateLiveToolCall(pack, name, args).ok, false);
    assert.equal(validateLiveToolCall(pack, name, { ...args, x_pct: 0.25 }, undefined, undefined, context).ok, false);
  }
  const tools = livePackTools(pack.authoredSeriesInstanceUIDs, "teach_me", context);
  assert.ok(JSON.stringify(tools).includes(anchorId));
  assert.ok(JSON.stringify(tools).includes(annotationId));
  assert.equal(JSON.stringify(livePackTools(pack.authoredSeriesInstanceUIDs, "examiner", context)).includes(anchorId), false);
  assert.ok(approvedToolsPrompt(context).includes('"frameCount":4'));
});

function viewerFor(frames: ToolFrame[]) {
  let ids = frames.map(imageId); let index = 0; const moves: number[] = []; const events: unknown[] = [];
  const viewer: ApprovedToolViewer = {
    activeSeriesUID: frames[0].seriesUID, seriesUIDs: [frames[0].seriesUID],
    getToolImageIds: () => ids, getToolImageId: () => ids[index],
    projectToolPoint: (x, y) => ({ x: x / 2 + 0.1, y: y / 2 + 0.2 }),
    showSeries: () => {}, settle: async () => {}, showState: async state => { moves.push(state.sliceIndex); index = state.sliceIndex; }, applyEvent: event => events.push(event),
  };
  return { viewer, moves, events, replace: (next: string[]) => { ids = next; } };
}

test("both client paths execute approved geometry only on the exact loaded frame, including reordered stacks", async () => {
  const { context, anchorId, annotationId } = await setup();
  const fake = viewerFor([...context.series[0].frames].reverse()); const points: unknown[] = [];
  assert.equal(await executeApprovedTool(resolveApprovedTool("point_to", { anchorId }, context)!, fake.viewer, async (x, y) => { points.push([x, y]); }), true);
  assert.deepEqual(fake.moves, [3]); assert.deepEqual(points, [[16 / 126 + 0.1, 32 / 126 + 0.2]]);
  assert.equal(await executeApprovedTool(resolveApprovedTool("draw_annotation", { annotationId }, context)!, fake.viewer, async () => {}), true);
  assert.equal(fake.events.length, 1); assert.equal((fake.events[0] as {sliceIndex: number}).sliceIndex, 3);
});

test("missing/duplicate/progressive image identity never substitutes an index or draws on a stale displayed frame", async () => {
  const { context, anchorId } = await setup();
  const action = resolveApprovedTool("point_to", { anchorId }, context)!;
  for (const kind of ["missing", "duplicate", "partial", "stale", "unavailable", "foreign-study", "wrong-frame"]) {
    const fake = viewerFor(context.series[0].frames); let points = 0;
    if (kind === "missing") fake.replace(context.series[0].frames.slice(1).map(imageId));
    if (kind === "duplicate") fake.replace([imageId(action.target), imageId(action.target)]);
    if (kind === "partial") fake.replace([imageId(context.series[0].frames[1])]);
    if (kind === "stale") fake.viewer.getToolImageId = () => imageId(context.series[0].frames[1]);
    if (kind === "unavailable") fake.viewer.getToolImageIds = undefined;
    if (kind === "foreign-study") fake.replace([imageId({ ...action.target, studyUID: "other" })]);
    if (kind === "wrong-frame") fake.replace([imageId({ ...action.target, frame: 2 })]);
    assert.equal(await executeApprovedTool(action, fake.viewer, async () => { points++; }), false, kind);
    assert.equal(points, 0); assert.deepEqual(fake.events, []);
    if (kind !== "stale") assert.deepEqual(fake.moves, []);
  }
});

test("REST caller carries catalog and keeps every valid action while removing invented geometry", async () => {
  const { context, anchorId, annotationId } = await setup();
  const previousFetch = globalThis.fetch; const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "synthetic-test-key";
  let request = "";
  const calls = [
    { name: "scroll_to", args: { sliceIndex: 0 } }, { name: "point_to", args: { anchorId } },
    { name: "draw_annotation", args: { annotationId } }, { name: "point_to", args: { anchorId, x_pct: 0.25 } },
    { name: "scroll_to", args: { sliceIndex: 4 } },
  ];
  globalThis.fetch = (async (_url, init) => { request = String(init?.body); return Response.json({ candidates: [{ content: { parts: calls.map(functionCall => ({ functionCall })) } }] }); }) as typeof fetch;
  try {
    const result = await runTeachingPlan({ question: "Review", mode: "guided", history: [], modality: "CT", caseTitle: "Synthetic", findingsContext: "Synthetic", approvedTools: context });
    assert.deepEqual(result.actions.map(a => a.type), ["scroll_to", "point_to", "draw_annotation"]);
    assert.deepEqual(result.action, result.actions[0]);
    assert.ok(request.includes(anchorId)); assert.ok(request.includes(annotationId));
    const noContext = await runTeachingPlan({ question: "Review", mode: "guided", history: [], modality: "CT", caseTitle: "Synthetic", findingsContext: "Synthetic" });
    assert.deepEqual(noContext.actions, []);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey; }
});

test("edit during metadata I/O cannot authorize the earlier version (server callers re-read current case)", async () => {
  const { data, inventory, metadata } = approved();
  const next = appendVersion(data, data.findings[0].id, prepareFinding(data.findings[0], { description: "Edited during inventory read" }, inventory), 1, expert.id);
  assert.deepEqual(await loadApprovedToolContext(data, async () => metadata, async () => next), emptyToolContext());
  assert.deepEqual(await loadApprovedToolContext(data, async () => metadata, async () => null), emptyToolContext());
});

test("malformed model arguments fail closed without throwing", async () => {
  const { context } = await setup();
  for (const name of ["set_series", "point_to", "draw_annotation", "scroll_to"]) {
    for (const args of [null, undefined, [], "0", 1]) {
      assert.deepEqual(harnessActionFromCall({ name, args: args as never }, context), { type: "none" });
    }
  }
});

test("a newly approved version cannot reuse an old anchor or annotation ID", async () => {
  const { data, inventory, metadata, anchorId, annotationId } = await setup();
  const next = appendVersion(data, data.findings[0].id, prepareFinding(data.findings[0], { description: "Expert revised text" }, inventory), 1, expert.id);
  const v = next.findingVersions!.at(-1)!;
  const current = approveVersion(next, data.findings[0].id, v.version, v.contentHash, expert, inventory);
  const context = await loadApprovedToolContext(current, async () => metadata);
  assert.notEqual(context.anchors[0].id, anchorId);
  assert.equal(resolveApprovedTool("point_to", { anchorId }, context), null);
  assert.equal(resolveApprovedTool("draw_annotation", { annotationId }, context), null);
  assert.ok(resolveApprovedTool("point_to", { anchorId: context.anchors[0].id }, context));
  assert.ok(resolveApprovedTool("draw_annotation", { annotationId: context.annotations[0].id }, context));
});

test("image-pixel points require the live camera projection; absent or off-screen projection never becomes a viewport coordinate", async () => {
  const { context, anchorId } = await setup();
  const action = resolveApprovedTool("point_to", { anchorId }, context)!;
  for (const project of [undefined, () => null, () => ({ x: -1, y: 0.5 }), () => ({ x: NaN, y: 0.5 })]) {
    const fake = viewerFor(context.series[0].frames); let points = 0;
    fake.viewer.projectToolPoint = project;
    assert.equal(await executeApprovedTool(action, fake.viewer, async () => { points++; }), false);
    assert.equal(points, 0);
  }
});
