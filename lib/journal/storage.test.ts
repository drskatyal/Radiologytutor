import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Case } from "../types";
import type { CaptureChunk, CaptureManifest, JournalEntry } from "./types";
import { journalTestView } from "./fixtures";
import { withMockCloud } from "../fixtures/cloudMock";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "journal-storage-"));
process.env.MONGODB_URI = "";
process.env.DICOMWEB_BACKEND = "orthanc";
const fixture = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8")) as Case;
const orgId = "synthetic-capture-org";
async function setup(caseId: string) {
  const store = await import("../cases");
  await store.saveCase({ ...fixture, caseId, orgId, findings: [], captureSessions: [] });
  return import("./storage");
}
const render: JournalEntry = { seq: 0, t: 100, kind: "render", snapshot: journalTestView, renderSeq: journalTestView.renderSeq };
function chunk(seq: number, data: string, stream: CaptureChunk["stream"] = "journal") {
  const bytes = Buffer.from(data);
  return { bytes, meta: { seq, stream, tStart: 100, tEnd: 100, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mime: stream === "journal" ? "application/json" : `${stream}/webm` } satisfies CaptureChunk };
}
test("chunk receipt is idempotent, changed bytes conflict, bad hashes fail, and foreign orgs cannot read or write", async () => {
  const s = await setup("capture-idempotent");
  await s.startCapture(orgId, "capture-idempotent", "take");
  const first = chunk(0, JSON.stringify([render]));
  const receipt = await s.putCaptureChunk(orgId, "capture-idempotent", "take", first.meta, first.bytes);
  assert.deepEqual(await s.putCaptureChunk(orgId, "capture-idempotent", "take", first.meta, first.bytes), receipt);
  assert.equal(readdirSync(join(process.env.DATA_DIR!, "captures", orgId, "capture-idempotent", "take")).length, 1);
  const changed = chunk(0, JSON.stringify([{ ...render, t: 90 }]));
  await assert.rejects(s.putCaptureChunk(orgId, "capture-idempotent", "take", changed.meta, changed.bytes), { status: 409 });
  await assert.rejects(s.putCaptureChunk(orgId, "capture-idempotent", "take", first.meta, Buffer.from("wrong")), /checksum/);
  await assert.rejects(s.readCaptureChunk("foreign", "capture-idempotent", "take", 0), { status: 404 });
  await assert.rejects(s.putCaptureChunk("foreign", "capture-idempotent", "take", first.meta, first.bytes), { status: 404 });
  assert.equal((await s.captureSession(orgId, "capture-idempotent", "take")).manifest!.chunks.length, 1);
});
test("completion rejects holes, forged offsets and missing journal entries; canonical evidence survives old save paths", async () => {
  const caseId = "capture-completion", id = "take";
  const s = await setup(caseId); const initial = await s.startCapture(orgId, caseId, id);
  const j = chunk(0, JSON.stringify([render])); const audio = chunk(2, "synthetic tone", "audio");
  await s.putCaptureChunk(orgId, caseId, id, j.meta, j.bytes);
  await s.putCaptureChunk(orgId, caseId, id, audio.meta, audio.bytes);
  const proposed: CaptureManifest = { ...initial, durationMs: 1000, chunks: [j.meta, audio.meta], offsets: { audio: 100 } };
  await assert.rejects(s.completeCapture(orgId, caseId, id, proposed), { status: 409 });
  const gap = chunk(1, JSON.stringify([{ seq: 1, t: 100, kind: "discontinuity", payload: { reason: "permission_delay" } }]));
  await s.putCaptureChunk(orgId, caseId, id, gap.meta, gap.bytes);
  proposed.chunks = [j.meta, gap.meta, audio.meta];
  await assert.rejects(s.completeCapture(orgId, caseId, id, { ...proposed, offsets: { audio: 0 } }), /offset/);
  const complete = await s.completeCapture(orgId, caseId, id, proposed);
  assert.equal(complete.manifest!.status, "complete"); assert.equal(complete.audioOffsetMs, 100);
  assert.deepEqual(complete.track.start.snapshot, journalTestView);
  await assert.rejects(s.captureMedia(orgId, caseId, id, "audio", true), /PHI/);
  await assert.rejects(s.retainGeminiVideo(orgId, caseId, id, { uri: "https://generativelanguage.googleapis.com/v1beta/files/synthetic-video", mimeType: "video/webm" }), /PHI/);
  await s.reviewCapture(orgId, caseId, id, { pixels: true, audio: true, screen: true });
  assert.equal((await s.captureMedia(orgId, caseId, id, "audio", true)).bytes.toString(), "synthetic tone");
  await s.retainGeminiVideo(orgId, caseId, id, { uri: "https://generativelanguage.googleapis.com/v1beta/files/synthetic-video", mimeType: "video/webm" });
  assert.equal((await s.captureSession(orgId, caseId, id)).geminiVideo!.uri, "https://generativelanguage.googleapis.com/v1beta/files/synthetic-video");
  await assert.rejects(s.retainGeminiVideo(orgId, caseId, id, { uri: "https://foreign.invalid/video", mimeType: "video/webm" }), /Invalid retained video/);
  const { appendCaptureSession } = await import("../cases");
  const saved = await appendCaptureSession(orgId, caseId, { ...complete, track: { start: { sliceIndex: 999 }, events: [], durationMs: 1 }, manifest: { ...proposed, chunks: [] } });
  assert.equal(saved.captureSessions![0].manifest!.chunks.length, 3);
  assert.deepEqual(saved.captureSessions![0].track.start.snapshot, journalTestView);
  await assert.rejects(s.putCaptureChunk(orgId, caseId, id, { ...audio.meta, seq: 3 }, audio.bytes), { status: 409 });
});
test("invalid render/PHI journals cannot be acknowledged and unreviewed/incomplete media never reaches model upload", async () => {
  const s = await setup("capture-guards"); await s.startCapture(orgId, "capture-guards", "take");
  for (const entry of [ { ...render, snapshot: { ...journalTestView, sopUID: "" } }, { ...render, payload: { PatientName: "DOE^JANE" } } ]) {
    const c = chunk(0, JSON.stringify([entry]));
    await assert.rejects(s.putCaptureChunk(orgId, "capture-guards", "take", c.meta, c.bytes));
  }
  assert.equal((await s.captureSession(orgId, "capture-guards", "take")).manifest!.chunks.length, 0);
  await assert.rejects(s.captureMedia(orgId, "capture-guards", "take", "video", true), /Complete capture/);
});
test("durable capture objects use the existing private GCS seam with mocked ADC and HTTP only", async t => {
  await withMockCloud(t, async () => {
    const { putCaptureObject, getCaptureObject } = await import("../durableStore");
    const bytes = Buffer.from("synthetic media only");
    const key = `captures/org/case/take/${createHash("sha256").update(bytes).digest("hex")}`;
    await putCaptureObject(key, bytes, "video/webm");
    assert.deepEqual(await getCaptureObject(key), bytes);
    await assert.rejects(getCaptureObject("captures/../../private"), /Invalid capture/);
  });
});
