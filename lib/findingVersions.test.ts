import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Case, Finding } from "./types";
import { FindingConflict, findingContent, hashContent } from "./findingContent";
import { migrateFindings } from "./findingVersions";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "finding-versions-"));
process.env.MONGODB_URI = "";
process.env.IMAGING_BACKEND = "orthanc";
const fixture = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8")) as Case;
const metadata = JSON.parse(readFileSync("fixtures/synthetic/study.json", "utf8")).instances.map((i: { metadata: unknown }) => i.metadata);
const expert = { id: "expert", membershipRole: "author" as const };
const review = { pixels: true, audio: true, screen: true };
const base = (id: string): Case => ({ ...structuredClone(fixture), caseId: id, orgId: "versions-org", createdAt: "2026-01-01", updatedAt: "2026-01-01", findings: [] });
const f = (id: string): Finding => ({ ...fixture.findings[id === "B" ? 1 : 0], id, frameNumber: 1, phiReview: review });

test("JSON versions: A1/B1 → A2 keeps only B1 approved, rejects stale/hash/role/tenant failures", async () => {
  const server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(metadata.filter((m: Record<string, {Value: string[]}>) => req.url?.includes(m["0020000E"].Value[0])))); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.ORTHANC_URL = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  try {
    const store = await import("./cases");
    const id = "version-json";
    await store.saveCase(base(id));
    await store.createFinding("versions-org", id, f("A"));
    await store.createFinding("versions-org", id, f("B"));
    let data = (await store.getCaseForOrg("versions-org", id))!;
    for (const v of data.findingVersions!) await store.approve("versions-org", id, v.findingId, 1, v.contentHash, expert);
    assert.deepEqual((await store.approvedCurrent("versions-org", id)).map(f => f.id), ["A", "B"]);
    const a1 = data.findingVersions![0];
    await assert.rejects(store.approve("versions-org", id, "A", 1, "wrong", expert), (e: FindingConflict) => e.status === 409);
    await assert.rejects(store.approve("versions-org", id, "A", 1, a1.contentHash, { id: "student", membershipRole: "student" }), (e: FindingConflict) => e.status === 403);
    await assert.rejects(store.createVersion("other-org", id, "A", { label: "wrong tenant" }, { expectedVersion: 1, userId: "x" }));
    data = await store.createVersion("versions-org", id, "A", { description: "Edited by expert" }, { expectedVersion: 1, userId: expert.id });
    assert.equal(data.findings[0].status, "needs_review");
    assert.deepEqual(data.findingVersions![0], a1);
    assert.equal(data.findingVersions![2].parentVersion, 1);
    assert.equal(data.findingVersions![2].contentHash, hashContent(findingContent(data.findings[0])));
    assert.deepEqual((await store.approvedCurrent("versions-org", id)).map(f => f.id), ["B"]);
    const projected = await store.groundedCase(data);
    assert.equal(projected.primaryDiagnosis, undefined);
    assert.deepEqual(projected.findings.map(f => f.id), ["B"]);
    assert.ok(!JSON.stringify(projected).includes(f("A").description));
    // Exercise the real tutor request builder with a mocked provider response.
    const { runTeachingPlan } = await import("./gemini");
    const { formatFindingsContextFromCase } = await import("./teachingPrompt");
    const originalFetch = globalThis.fetch;
    process.env.GEMINI_API_KEY = "unit-test-only-mock";
    try {
      globalThis.fetch = async (_url, options) => {
        const request = String(options?.body);
        assert.ok(request.includes(f("B").description));
        assert.ok(!request.includes(f("A").description));
        assert.ok(!request.includes(fixture.primaryDiagnosis!));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: f("B").description }] } }] }), { status: 200 });
      };
      const plan = await runTeachingPlan({ question: "Teach this case", history: [], mode: "guided", caseTitle: projected.title, modality: "CT", findingsContext: formatFindingsContextFromCase(projected) });
      assert.equal(plan.answer, f("B").description);
    } finally { globalThis.fetch = originalFetch; delete process.env.GEMINI_API_KEY; }

    await assert.rejects(store.createVersion("versions-org", id, "A", { label: "stale" }, { expectedVersion: 1, userId: "late" }), (e: FindingConflict) => e.status === 409);
    const raced = await Promise.allSettled(["first", "second"].map(label => store.createVersion("versions-org", id, "A", { label }, { expectedVersion: 2, userId: "expert" })));
    assert.equal(raced.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(raced.filter(r => r.status === "rejected" && r.reason.status === 409).length, 1);
    await assert.rejects(store.saveCase(data), /versioned finding API/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("legacy migration grants no approval; incomplete and missing exact identities fail closed", async () => {
  const store = await import("./cases");
  process.env.ORTHANC_URL = "";
  const legacy = migrateFindings({ ...base("legacy"), findings: [fixture.findings[0]] });
  assert.equal(legacy.findings[0].currentVersion, 1);
  assert.equal(legacy.findings[0].anchorStatus, "legacy_index");
  assert.equal(legacy.findings[0].approvedVersion, undefined);
  await store.saveCase({ ...base("missing"), findings: [fixture.findings[0], { ...f("missing-instance"), sopInstanceUID: "missing", frameNumber: 1 }] });
  const data = (await store.getCaseForOrg("versions-org", "missing"))!;
  assert.equal(data.findings[1].anchorStatus, "unresolved");
  for (const v of data.findingVersions!) await assert.rejects(store.approve("versions-org", "missing", v.findingId, 1, v.contentHash, expert), (e: FindingConflict) => e.status === 422);
  assert.deepEqual(await store.approvedCurrent("versions-org", "missing"), []);
});

test("compile commit is additive and idempotent across an expert edit", async () => {
  const store = await import("./cases");
  const id = "compile-additive";
  await store.saveCase({ ...base(id), findings: [f("original")] });
  await store.appendCaptureSession("versions-org", id, { id: "take", createdAt: "2026-01-01", track: { start: { sliceIndex: 0, ww: 400, wc: 40 }, events: [], durationMs: 1000 } } as never);
  const input = { captureSessionId: "take", findings: [{ label: "Draft", markerId: "marker-1", tStartMs: 0, tEndMs: 1000 }] };
  let data = await store.commitLiveTeachingPack("versions-org", id, input);
  const compiled = data.findings.find(f => f.captureSessionId === "take")!;
  assert.equal(data.findings.length, 2);
  data = await store.updateFindingScoped("versions-org", id, compiled.id, { label: "Expert version" });
  data = await store.commitLiveTeachingPack("versions-org", id, input);
  assert.equal(data.findings.length, 2);
  assert.equal(data.findings.find(f => f.id === compiled.id)?.label, "Expert version");
  assert.equal(data.findingVersions!.filter(v => v.findingId === compiled.id).length, 2);
});

test("Mongo finding CAS integration", { skip: "NOT EXECUTED: no local mongod is installed; no remote Mongo permitted" }, () => {});
