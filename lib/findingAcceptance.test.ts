import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Case, Finding, SeriesInventory } from "./types";
import { approvedFinding, approveVersion, appendVersion, prepareFinding, snapshot } from "./findingVersions";
import { inventoryFromMetadata, instanceSetFingerprint, resolveFindingAnchor } from "./findingInventory";
import { anchorFromFinding, FindingConflict } from "./findingContent";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "finding-acceptance-"));
process.env.MONGODB_URI = "";
process.env.IMAGING_BACKEND = "orthanc";
const fixture = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8")) as Case;
const rows = JSON.parse(readFileSync("fixtures/synthetic/study.json", "utf8")).instances.filter((i: {seriesUID: string}) => i.seriesUID === fixture.findings[0].seriesInstanceUID).map((i: {metadata: unknown}) => i.metadata);
const f: Finding = { ...fixture.findings[0], frameNumber: 1, phiReview: { pixels: true, audio: true, screen: true } };
const inventory = inventoryFromMetadata(anchorFromFinding(f)!, rows);
const expert = { id: "expert", membershipRole: "author" as const };
function approved(): Case {
  const current = { ...prepareFinding(f, {}, inventory), currentVersion: 1, status: "needs_review" as const };
  const v = snapshot(current, 1, "expert", "2026-01-01");
  const data = { ...fixture, createdAt: "2026-01-01", updatedAt: "2026-01-01", findings: [current], findingVersions: [v], findingApprovals: [] };
  return approveVersion(data, f.id, 1, v.contentHash, expert, inventory);
}

test("T1/T9 pure archive reorder preserves exact SOP/frame and records revalidation", async () => {
  let responseRows = rows;
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(responseRows)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.ORTHANC_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const store = await import("./cases");
    const data = approved();
    await store.saveCase({ ...data, findings: [], findingVersions: [], findingApprovals: [] });
    await store.mutateCase(data.orgId, data.caseId, () => data);
    const persisted = (await store.getCaseForOrg(data.orgId, data.caseId))!;
    const first = await store.approvedCurrent(data.orgId, data.caseId);
    responseRows = [...rows].reverse();
    const second = await store.approvedCurrent(data.orgId, data.caseId);
    assert.equal(second[0].sopInstanceUID, first[0].sopInstanceUID);
    assert.equal(second[0].frameNumber, first[0].frameNumber);
    const latest = (await store.getCaseForOrg(data.orgId, data.caseId))!;
    assert.deepEqual(latest.findingVersions, persisted.findingVersions);
    assert.equal(latest.findings[0].approvedVersion, 1);
    assert.equal(latest.findingRevalidations!.length, 2);
    assert.notEqual(latest.findingRevalidations![0].inventoryOrderHash, latest.findingRevalidations![1].inventoryOrderHash);
    assert.equal(latest.findingRevalidations![1].contentHash, data.findingVersions![0].contentHash);
    await store.approvedCurrent(data.orgId, data.caseId);
    assert.equal((await store.getCaseForOrg(data.orgId, data.caseId))!.findingRevalidations!.length, 2);
    responseRows = rows.filter((r: Record<string, {Value: string[]}>) => r["00080018"].Value[0] !== f.sopInstanceUID);
    assert.deepEqual(await store.approvedCurrent(data.orgId, data.caseId), []);
    const stale = (await store.getCaseForOrg(data.orgId, data.caseId))!.findings[0];
    assert.equal(stale.status, "needs_review");
    assert.equal(stale.approvedVersion, undefined);
    assert.equal(stale.anchorStatus, "unresolved");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("T2/P0-1 every component of Study/Series/SOP/frame identity is required", () => {
  for (const key of ["studyInstanceUID", "seriesInstanceUID", "sopInstanceUID", "frameNumber"] as const) {
    const data = approved();
    const next = prepareFinding(data.findings[0], { [key]: undefined }, inventory);
    assert.equal(next.anchorStatus, "legacy_index", key);
    assert.equal(next.sliceIndex, data.findings[0].sliceIndex, "index remains a display hint only");
    const updated = appendVersion(data, f.id, next, 1, "expert");
    const v = updated.findingVersions!.at(-1)!;
    assert.throws(() => approveVersion(updated, f.id, 2, v.contentHash, expert, inventory), (e: FindingConflict) => e.status === 422);
    assert.equal(approvedFinding(updated, updated.findings[0], inventory), null);
  }
});

test("T3 missing instance or frame is unresolved, never nearest-slice substitution", () => {
  const a = anchorFromFinding(f)!;
  const removed = { ...inventory, instances: inventory.instances.filter(i => i.sopUID !== a.sopUID) };
  assert.equal(resolveFindingAnchor(a, removed), "unresolved");
  assert.equal(resolveFindingAnchor({ ...a, frame: 2 }, inventory), "unresolved");
  assert.equal(resolveFindingAnchor({ ...a, sopUID: "missing" }, inventory), "unresolved");
  assert.equal(resolveFindingAnchor({ ...a, frame: 0 }, inventory), "legacy_index");
  assert.equal(approvedFinding(approved(), approved().findings[0], removed), null);
});

test("T9 hash coverage and stale-on-change", async t => {
  const changes: Array<[string, Partial<Finding>]> = [
    ["text", { description: "Changed" }], ["label", { label: "Changed" }],
    ["teaching points", { teachingPoints: ["Changed"] }], ["rubric", { reportMustMention: ["Changed"] }],
    ["gold report", { reportGold: "Changed" }], ["marker", { marker: { ...f.marker, x_pct: 0.6 } }],
    ["pixel coordinates", { imagePoint: { x: 8, y: 9 } }],
    ["measurement", { measurements: [{ id: "m", lengthMm: 6, spacingSource: "PixelSpacing" }] as never }],
    ["annotation", { annotations: [{ id: "a", imagePoints: [[1, 2], [3, 4]] }] }],
    ["window", { windowWidth: 999 }], ["view state", { anchor: { ...anchorFromFinding(f)!, view: { zoom: 2, pan: [1, 2], rotation: 20, invert: true } } }],
    ["SOP", { sopInstanceUID: inventory.instances[1].sopUID }],
    ["model", { provenance: { ...approved().findings[0].provenance!, modelId: "model-v2" } }],
    ["prompt", { provenance: { ...approved().findings[0].provenance!, promptVersion: "prompt-v2" } }],
    ["media review", { phiReview: { pixels: false, audio: true, screen: true } }],
  ];
  for (const [name, patch] of changes) await t.test(name, () => {
    const data = approved();
    const next = appendVersion(data, f.id, prepareFinding(data.findings[0], patch, inventory), 1, "expert");
    assert.notEqual(next.findingVersions![1].contentHash, data.findingVersions![0].contentHash);
    assert.equal(next.findings[0].status, "needs_review");
    assert.equal(approvedFinding(next, next.findings[0], inventory), null);
    assert.deepEqual(next.findingVersions![0], data.findingVersions![0]);
  });
  for (const changed of [
    { ...inventory, orderingAlgorithmVersion: "anatomical-v2" },
    { ...inventory, instances: [...inventory.instances, { sopUID: "added", frames: 1 }] },
    { ...inventory, instances: inventory.instances.map(i => ({ ...i, geometryHash: "changed-calibration" })) },
  ] satisfies SeriesInventory[]) {
    const data = approved();
    assert.equal(approvedFinding(data, data.findings[0], changed), null);
    const next = appendVersion(data, f.id, prepareFinding(data.findings[0], {}, changed), 1, "expert");
    assert.notEqual(next.findingVersions![1].contentHash, data.findingVersions![0].contentHash);
  }
  assert.equal(instanceSetFingerprint(inventory), instanceSetFingerprint({ ...inventory, instances: [...inventory.instances].reverse() }));
});

test("approval rejects dirty or unchecked content and tampered snapshot hashes", () => {
  for (const patch of [{ description: "Patient ID: ACC12345" }, { phiReview: { pixels: true, audio: false, screen: true } }]) {
    const data = approved();
    const next = appendVersion(data, f.id, prepareFinding(data.findings[0], patch, inventory), 1, "expert");
    assert.throws(() => approveVersion(next, f.id, 2, next.findingVersions![1].contentHash, expert, inventory), /PHI review required/);
  }
  const data = approved();
  data.findingVersions![0].content.label = "tampered";
  assert.equal(approvedFinding(data, data.findings[0], inventory), null);
});
