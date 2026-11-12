import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Case } from "../types";
import { markerTrack } from "./fixtures";
import { resolveAnchor } from "./resolve";
import { notesDrafts } from "./notes";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "marker-commit-"));
process.env.MONGODB_URI = "";
process.env.DICOMWEB_BACKEND = "orthanc";
const fixture = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8")) as Case;
async function setup(caseId: string) {
  const store = await import("../cases");
  const track = markerTrack();
  await store.saveCase({ ...fixture, caseId, orgId: "markers-org", findings: [], captureSessions: [] });
  const storage = await import("../journal/storage");
  const manifest = await storage.startCapture("markers-org", caseId, "take");
  const bytes = Buffer.from(JSON.stringify(track.journal));
  const chunk = { seq: 0, stream: "journal" as const, tStart: 0, tEnd: 220, bytes: bytes.length, mime: "application/json", sha256: createHash("sha256").update(bytes).digest("hex") };
  await storage.putCaptureChunk("markers-org", caseId, "take", chunk, bytes);
  const session = await storage.completeCapture("markers-org", caseId, "take", { ...manifest, durationMs: 1000, chunks: [chunk] });
  return { store, track: session.track };
}
test("notes and AI server commits resolve retained IDs, ignore invented geometry and keep retry identity", async () => {
  for (const voice of ["notes", undefined] as const) {
    const caseId = `markers-${voice ?? "ai"}`;
    const { store, track } = await setup(caseId);
    const findings = notesDrafts(track).map((p, i) => ({ ...p, label: `Synthetic finding ${i + 1}`, sopInstanceUID: "9.9.9", imagePoint: { x: 999, y: 999 } }));
    const result = await store.commitLiveTeachingPack("markers-org", caseId, { captureSessionId: "take", findings, voice });
    assert.equal(result.findings.length, 3);
    result.findings.forEach((f, i) => {
      assert.deepEqual(f.resolvedAnchor, resolveAnchor(`marker-${i}`, track.journal!));
      assert.equal(f.sopInstanceUID, `1.2.3.${i + 4}`); assert.equal(f.frameNumber, 1);
      assert.equal(f.anchorStatus, "resolved"); assert.equal(f.status, "needs_review");
      assert.equal(f.track?.voice, voice);
      assert.equal(result.findingVersions!.filter(v => v.findingId === f.id).length, 1);
    });
    const retained = (await store.getCaseForOrg("markers-org", caseId))!;
    const again = await store.commitLiveTeachingPack("markers-org", caseId, { captureSessionId: "take", findings, voice });
    assert.deepEqual(again.findingVersions, retained.findingVersions);
    await assert.rejects(store.commitLiveTeachingPack("foreign", caseId, { captureSessionId: "take", findings, voice }));
  }
});
test("server retains explicit group/omit decisions and rejects foreign IDs; all omitted remains auditable", async () => {
  const { store } = await setup("markers-group");
  const markerDecisions = [{ kind: "group" as const, markerIds: ["marker-0", "marker-1"], reason: "Same synthetic finding" }, { kind: "omit" as const, markerIds: ["marker-2"], reason: "Accidental click" }];
  const result = await store.commitLiveTeachingPack("markers-org", "markers-group", { captureSessionId: "take", findings: [], markerDecisions });
  assert.equal(result.findings.length, 1); assert.deepEqual(result.captureSessions![0].markerDecisions, markerDecisions);
  assert.deepEqual(result.findings[0].markerReconciliation, markerDecisions[0]);
  await assert.rejects(store.commitLiveTeachingPack("markers-org", "markers-group", { captureSessionId: "take", findings: [], markerDecisions: [{ ...markerDecisions[1], markerIds: ["foreign"] }] }), /reconciliation/);
  await setup("markers-omitted");
  const omitted = await store.commitLiveTeachingPack("markers-org", "markers-omitted", { captureSessionId: "take", findings: [], markerDecisions: [{ kind: "omit", markerIds: ["marker-0", "marker-1", "marker-2"], reason: "Test take discarded by author" }] });
  assert.equal(omitted.findings.length, 0); assert.equal(omitted.captureSessions![0].markerDecisions!.length, 1);
});
