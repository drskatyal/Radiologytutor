import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalTestView } from "../journal/fixtures";
import type { Case, Finding } from "../types";
import { hashContent } from "../findingContent";
import { versionDiff } from "./model";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "finding-review-")); process.env.MONGODB_URI = "";
process.env.DICOMWEB_BACKEND = "orthanc"; process.env.ORTHANC_URL = "http://synthetic-archive.invalid";
const fixture = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8")) as Case;
const study = JSON.parse(readFileSync("fixtures/synthetic/study.json", "utf8"));
const instances = study.instances.filter((i: { seriesUID: string }) => i.seriesUID === study.seriesUIDs[0]);
const rows = instances.map((i: { metadata: unknown }) => i.metadata);
const s = { ...journalTestView, studyUID: study.studyUID, seriesUID: study.seriesUIDs[0], sopUID: instances[0].sopUID };
const evidence = { snapshot: s, imagePoint: { x: 10, y: 20 }, dimensions: [64, 64] as [number, number] };
const orgId = "review-org", user = { id: "synthetic-expert", membershipRole: "author" as const };
async function setup(caseId: string, fn: (ctx: { store: typeof import("../cases"); api: typeof import("./server"); setRows: (r: unknown) => void; calls: () => number }) => Promise<void>) {
  let metadata: unknown = structuredClone(rows), calls = 0; const previous = global.fetch;
  global.fetch = async () => { calls++; return Response.json(metadata); };
  try {
    const store = await import("../cases"), api = await import("./server");
    await store.saveCase({ ...fixture, caseId, orgId, findings: [], captureSessions: [] });
    const original = { ...fixture.findings[0], id: "review-one", label: "Synthetic focus", phiReview: { pixels: true, audio: true, screen: true } };
    await store.createFinding(orgId, caseId, { ...original, ...api.rebindPatch(original, evidence, rows) } as Finding);
    await fn({ store, api, setRows: value => { metadata = value; }, calls: () => calls });
  } finally { global.fetch = previous; }
}

test("M7 author edits use exact version/hash, invalidate approval and expose an immutable history diff", async () => setup("edit", async ({ store, api }) => {
  let view = await api.loadCaseReview(orgId, "edit"), row = view.findings[0];
  assert.equal(row.canApprove, true); assert.equal(row.snapshot!.sopUID, s.sopUID);
  await store.approve(orgId, "edit", row.finding.id, row.version, row.contentHash, user);
  view = await api.loadCaseReview(orgId, "edit"); assert.equal(view.findings[0].approved, true);
  const data = await api.saveReview(orgId, "edit", row.finding.id, user.id, { expectedVersion: row.version, contentHash: row.contentHash, text: { label: "Edited focus", description: "Expert changed text", teachingPoints: ["Compare"] } });
  assert.equal(data.findings[0].currentVersion, 2); assert.equal(data.findings[0].status, "needs_review");
  assert.equal((await api.loadCaseReview(orgId, "edit")).findings[0].approved, false);
  assert.ok(versionDiff(data.findingVersions![0], data.findingVersions![1]).some(d => d.field === "description"));
  assert.equal(data.findingVersions![0].content.label, "Synthetic focus");
  await assert.rejects(api.saveReview(orgId, "edit", row.finding.id, user.id, { expectedVersion: 1, contentHash: row.contentHash, text: { label: "stale", description: "", teachingPoints: [] } }), /changed/);
  await assert.rejects(api.saveReview(orgId, "edit", row.finding.id, user.id, { expectedVersion: 2, contentHash: "wrong" }), /changed/);
}));

test("M7 T1/T9 pure metadata reorder preserves approved SOP/frame and logs revalidation", async () => setup("order", async ({ store, api, setRows }) => {
  const first = (await api.loadCaseReview(orgId, "order")).findings[0];
  await store.approve(orgId, "order", first.finding.id, first.version, first.contentHash, user);
  const before = await api.loadCaseReview(orgId, "order"); setRows([...rows].reverse());
  const after = await api.loadCaseReview(orgId, "order");
  assert.equal(after.findings[0].approved, true); assert.deepEqual(after.findings[0].snapshot, before.findings[0].snapshot);
  assert.equal(after.findings[0].contentHash, before.findings[0].contentHash);
  assert.equal(after.caseData.findingRevalidations!.length, 2);
  assert.notEqual(after.caseData.findingRevalidations![0].inventoryOrderHash, after.caseData.findingRevalidations![1].inventoryOrderHash);
}));

test("M7 T2/T3 missing identity or missing instance cannot approve or use a nearby index", async () => setup("missing", async ({ store, api, setRows }) => {
  const row = (await api.loadCaseReview(orgId, "missing")).findings[0];
  setRows(rows.filter((r: Record<string, { Value: unknown[] }>) => r["00080018"].Value[0] !== s.sopUID));
  let next = (await api.loadCaseReview(orgId, "missing")).findings[0];
  assert.equal(next.anchorStatus, "unresolved"); assert.equal(next.canApprove, false); assert.ok(next.reasons.includes("Image not found: rebind"));
  assert.equal(next.snapshot!.sopUID, s.sopUID);
  await assert.rejects(store.approve(orgId, "missing", row.finding.id, row.version, row.contentHash, user), /resolved/);
  setRows(rows);
  await store.createVersion(orgId, "missing", row.finding.id, { sopInstanceUID: undefined, anchor: undefined, sliceIndex: 1 }, { expectedVersion: 1, userId: user.id });
  next = (await api.loadCaseReview(orgId, "missing")).findings[0];
  assert.equal(next.anchorStatus, "legacy_index"); assert.equal(next.snapshot, null); assert.equal(next.canApprove, false);
}));

test("M7 rebind validates metadata/pixels, records render evidence and replaces old geometry with history retained", async () => setup("rebind", async ({ store, api }) => {
  const first = (await api.loadCaseReview(orgId, "rebind")).findings[0];
  await store.approve(orgId, "rebind", first.finding.id, first.version, first.contentHash, user);
  const target = { ...evidence, snapshot: { ...s, sopUID: instances[1].sopUID, camera: { ...s.camera, zoom: 1.5, pan: [12, -6] as [number, number] }, invert: true }, geometry: { calibration: "PixelSpacing", spacing: [999, 999] } };
  const data = await api.saveReview(orgId, "rebind", first.finding.id, user.id, { expectedVersion: 1, contentHash: first.contentHash, rebind: target as typeof evidence });
  const f = data.findings[0]; assert.equal(f.currentVersion, 2); assert.equal(f.sopInstanceUID, instances[1].sopUID); assert.equal(f.approvedVersion, undefined);
  assert.equal(f.resolvedAnchor!.snapshot!.invert, true); assert.deepEqual(f.resolvedAnchor!.snapshot!.camera.pan, [12, -6]);
  assert.notDeepEqual(f.resolvedAnchor!.geometry.spacing, [999, 999]); assert.deepEqual(f.resolvedAnchor!.dimensions, [64, 64]);
  assert.equal(f.expertReview!.sourceHash, first.contentHash); assert.equal(f.expertReview!.userId, user.id);
  assert.equal(data.findingVersions![0].anchor!.sopUID, s.sopUID); assert.notEqual(data.findingVersions![1].contentHash, first.contentHash);
  assert.throws(() => api.rebindPatch(f, { ...evidence, imagePoint: { x: 999, y: 20 } }, rows), /inside/);
  assert.throws(() => api.rebindPatch(f, { ...evidence, snapshot: { ...s, frame: 99 } }, rows), /not found/);
}));

test("M7 PHI, extraction uncertainty and stale content cannot be approved; explicit rebind review is audited", async () => setup("checks", async ({ store, api }) => {
  let row = (await api.loadCaseReview(orgId, "checks")).findings[0];
  const result = await store.createVersion(orgId, "checks", row.finding.id, { phiReview: { pixels: false, audio: false, screen: false }, extraction: { jobId: "synthetic", proposalIndexes: [0], dictatedOrVisual: "visual", confidence: .2, issues: ["low_confidence"], modelMetadata: { requestedModel: "mock", responseModelVersion: null, apiSurface: "generateContent", configHash: "mock" } } }, { expectedVersion: 1, userId: user.id });
  row = (await api.loadCaseReview(orgId, "checks")).findings[0]; assert.equal(row.canApprove, false); assert.ok(row.reasons.some(r => r.includes("uncertain"))); assert.ok(row.reasons.some(r => r.includes("identifiers")));
  await assert.rejects(api.saveReview(orgId, "checks", row.finding.id, user.id, { expectedVersion: 2, contentHash: row.contentHash, resolveExtraction: { reason: "Reviewed carefully" } }), /Rebind/);
  const reviewed = await api.saveReview(orgId, "checks", row.finding.id, user.id, { expectedVersion: 2, contentHash: row.contentHash, rebind: evidence, resolveExtraction: { reason: "Reviewed synthetic contour and corrected the anchor" }, phiReview: { pixels: true, audio: true, screen: true } });
  assert.deepEqual(reviewed.findings[0].extraction!.issues, []); assert.deepEqual(reviewed.findings[0].expertReview!.resolvedIssues, ["low_confidence"]);
  assert.deepEqual(result.findings[0].extraction!.issues, ["low_confidence"]);
  row = (await api.loadCaseReview(orgId, "checks")).findings[0]; assert.equal(row.canApprove, true);
  await assert.rejects(api.saveReview(orgId, "checks", row.finding.id, user.id, { expectedVersion: 3, contentHash: row.contentHash, text: { label: "PatientID: DIRTY_CANARY", description: "", teachingPoints: [] } }), /PHI/);
  await store.mutateCase(orgId, "checks", data => { data.findings[0].description = "unversioned corruption"; return data; });
  row = (await api.loadCaseReview(orgId, "checks")).findings[0]; assert.equal(row.canApprove, false); assert.ok(row.reasons.some(r => r.includes("version changed")));
}));

test("M7 review/rebind is scoped before image I/O and does not accept unrelated case images", async () => setup("scope", async ({ api, calls }) => {
  const row = (await api.loadCaseReview(orgId, "scope")).findings[0], before = calls();
  await assert.rejects(api.loadCaseReview("other-org", "scope"), /not found/);
  await assert.rejects(api.saveReview("other-org", "scope", row.finding.id, user.id, { expectedVersion: 1, contentHash: row.contentHash, rebind: evidence }), /not found/);
  await assert.rejects(api.saveReview(orgId, "scope", row.finding.id, user.id, { expectedVersion: 1, contentHash: row.contentHash, rebind: { ...evidence, snapshot: { ...s, seriesUID: "9.9.9" } } }), /from this case/);
  assert.equal(calls(), before);
}));

test("M7 rebind metadata I/O cannot overwrite a version saved by another reviewer", async () => setup("race", async ({ store, api }) => {
  const row = (await api.loadCaseReview(orgId, "race")).findings[0];
  const metadataFetch = global.fetch; let raced = false;
  global.fetch = async (...args) => {
    if (!raced) {
      raced = true;
      await store.createVersion(orgId, "race", row.finding.id, { label: "Concurrent expert correction" }, { expectedVersion: 1, userId: "other-expert" });
    }
    return metadataFetch(...args);
  };
  await assert.rejects(api.saveReview(orgId, "race", row.finding.id, user.id, { expectedVersion: 1, contentHash: row.contentHash, rebind: evidence, text: { label: "Outdated local correction", description: "", teachingPoints: [] } }), /changed/);
  const saved = await store.getCaseForOrg(orgId, "race");
  assert.equal(saved!.findings[0].label, "Concurrent expert correction");
  assert.equal(saved!.findingVersions!.length, 2);
}));
