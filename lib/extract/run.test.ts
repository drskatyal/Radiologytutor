import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markerTrack } from "../anchors/fixtures";
import { hashContent } from "../findingContent";
import { approveVersion } from "../findingVersions";
import { buildGenerateRequest, type GenerateOptions } from "../gemini";
import type { CaptureChunk } from "../journal/types";
import type { Case } from "../types";
import type { ExtractProposal } from "./schema";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "extraction-"));
process.env.MONGODB_URI = ""; process.env.DICOMWEB_BACKEND = "orthanc"; process.env.ORTHANC_URL = "";
const org = "extract-org", user = "synthetic-author", sessionId = "take";
const fixture = JSON.parse(readFileSync("fixtures/synthetic/case.json", "utf8")) as Case;
const proposals = (count = 2): ExtractProposal[] => Array.from({ length: count }, (_, i) => ({ label: `Synthetic focus ${i + 1}`, description: "Observe the contour", teachingPoints: ["Compare adjacent images"], dictatedOrVisual: "both", confidence: .95, markerId: `marker-${i}`, evidence: [{ tStart: i * 100, tEnd: i * 100 + 60, journalSeq: [i * 2, i * 2 + 1] }] }));
function model(rows: unknown[], calls?: GenerateOptions[]) {
  return async (options: GenerateOptions) => { calls?.push(options); return { text: JSON.stringify({ findings: rows }), modelMetadata: { requestedModel: options.model!, responseModelVersion: "synthetic-mock", apiSurface: "generateContent" as const, configHash: hashContent({ model: options.model, body: buildGenerateRequest(options, options.model!) }) } }; };
}
async function setup(caseId: string, count = 2, review = true, videoBytes = Buffer.from("SYNTHETIC_VIDEO")) {
  const store = await import("../cases"), storage = await import("../journal/storage"), run = await import("./run");
  await store.saveCase({ ...fixture, caseId, orgId: org, findings: [], captureSessions: [], primaryDiagnosis: "CANARY_CASE_ANSWER" });
  const journal = markerTrack().journal!.slice(0, count * 2);
  const manifest = await storage.startCapture(org, caseId, sessionId);
  const chunks: CaptureChunk[] = [];
  for (const [stream, bytes, mime] of [["journal", Buffer.from(JSON.stringify(journal)), "application/json"], ["audio", Buffer.from("SYNTHETIC_AUDIO"), "audio/wav"], ["video", videoBytes, "video/webm"]] as const) {
    const chunk = { seq: chunks.length, stream, tStart: 0, tEnd: 1000, bytes: bytes.length, mime, sha256: createHash("sha256").update(bytes).digest("hex") }; chunks.push(chunk);
    await storage.putCaptureChunk(org, caseId, sessionId, chunk, bytes);
  }
  await storage.completeCapture(org, caseId, sessionId, { ...manifest, durationMs: 1000, chunks, offsets: { audio: 0, video: 0 } });
  if (review) await storage.reviewCapture(org, caseId, sessionId, { pixels: true, audio: true, screen: true });
  return { store, storage, run, session: await storage.captureSession(org, caseId, sessionId) };
}

test("M6 persisted job reuses same request/result and binds geometry only to retained evidence", async () => {
  const { run, session, store } = await setup("repeated"); const calls: GenerateOptions[] = [];
  const dirty = proposals().map(p => ({ ...p, sopInstanceUID: "MODEL_CANARY_UID", frame: 999, coordinates: [900, 800], PatientName: "DIRTY^SYNTHETIC" }));
  const first = await run.runExtraction(org, "repeated", sessionId, user, {}, { generate: model(dirty, calls) });
  assert.equal(first.status, "ready"); assert.equal(first.attempts, 1); assert.equal(first.drafts.length, 2);
  assert.equal(first.modelMetadata!.responseModelVersion, "synthetic-mock");
  assert.deepEqual(first.drafts.map(d => d.finding.sopInstanceUID), ["1.2.3.4", "1.2.3.5"]);
  assert.deepEqual(first.drafts.map(d => d.finding.imagePoint), [{ x: 10, y: 20 }, { x: 11, y: 20 }]);
  assert.ok(first.drafts.every(d => !d.issues.length && d.finding.anchorStatus === "resolved"));
  const again = await run.runExtraction(org, "repeated", sessionId, user, { retry: true }, { generate: model([], calls) });
  assert.deepEqual(again, first); assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes("CANARY_CASE_ANSWER")); assert.ok(!JSON.stringify(first).includes("MODEL_CANARY_UID"));
  assert.equal((await run.getExtraction(org, "repeated", sessionId))!.id, first.id);
  assert.notEqual(run.extractionIdentity(session.manifest!, "different-model").id, first.id);
  assert.notEqual(run.extractionIdentity(session.manifest!, first.modelId, "v2").id, first.id);
  assert.notEqual(run.extractionIdentity(session.manifest!, first.modelId, first.extractorVersion, "prompt2").id, first.id);
  assert.notEqual(run.extractionIdentity({ ...session.manifest!, durationMs: 1001 }).id, first.id);
  const stored = await store.getCaseForOrg(org, "repeated"); assert.equal(stored!.findings.length, 0);
});

test("M6 concurrent requests share one lease; failed jobs retry explicitly with the same identity", async () => {
  const { run } = await setup("concurrent");
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const calls: GenerateOptions[] = [];
  const first = run.runExtraction(org, "concurrent", sessionId, user, {}, { generate: async o => { started(); await blocked; return model(proposals(), calls)(o); } });
  await entered;
  const second = await run.runExtraction(org, "concurrent", sessionId, user, { retry: true }, { generate: model([], calls) });
  assert.equal(second.status, "running"); assert.equal(second.attempts, 1); release();
  assert.equal((await first).id, second.id); assert.equal(calls.length, 1);
  await setup("failure");
  const failed = await run.runExtraction(org, "failure", sessionId, user, {}, { generate: async () => { throw new Error("SENSITIVE_PROVIDER_ERROR"); } });
  assert.equal(failed.errorCode, "EXTRACTION_FAILED"); assert.ok(!JSON.stringify(failed).includes("SENSITIVE"));
  assert.deepEqual(await run.runExtraction(org, "failure", sessionId, user, {}, { generate: model(proposals()) }), failed);
  const retry = await run.runExtraction(org, "failure", sessionId, user, { retry: true }, { generate: model(proposals()) });
  assert.equal(retry.status, "ready"); assert.equal(retry.id, failed.id); assert.equal(retry.attempts, 2);
});

test("M6 expired worker cannot replace the result of a recovered lease", async () => {
  const { run } = await setup("lease"); let now = 0, release!: () => void, started!: () => void;
  const blocked = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
  const old = run.runExtraction(org, "lease", sessionId, user, {}, { now: () => now, generate: async o => { started(); await blocked; return model([{ ...proposals()[0], label: "Obsolete worker" }])(o); } });
  await entered; now = 16 * 60000;
  const recovered = await run.runExtraction(org, "lease", sessionId, user, { retry: true }, { now: () => now, generate: model(proposals()) });
  assert.equal(recovered.attempts, 2); release(); assert.deepEqual(await old, recovered);
});

test("M6 lost commit response retry creates exactly two findings and preserves later expert edits", async () => {
  const { run, store } = await setup("lost-response");
  const job = await run.runExtraction(org, "lost-response", sessionId, user, {}, { generate: model(proposals()) });
  // Simulate process death between the atomic version write and job receipt update.
  const first = job.drafts[0];
  await store.createVersion(org, "lost-response", first.finding.id, first.finding, { expectedVersion: first.expectedVersion, userId: user, sourceKey: first.sourceKey });
  await store.createVersion(org, "lost-response", first.finding.id, { label: "Later expert edit" }, { expectedVersion: 1, userId: user });
  const committed = await run.commitExtraction(org, "lost-response", sessionId, job.id, user);
  assert.equal(committed.status, "committed"); assert.equal(committed.receipts.length, 2);
  assert.equal(committed.receipts[0].version, 1);
  const retry = await run.commitExtraction(org, "lost-response", sessionId, job.id, user);
  assert.deepEqual(retry, committed);
  const data = (await store.getCaseForOrg(org, "lost-response"))!;
  assert.equal(data.findings.length, 2); assert.equal(data.findings[0].label, "Later expert edit"); assert.equal(data.findings[0].currentVersion, 2);
  assert.equal(data.findingVersions!.length, 3);
  assert.equal(new Set(data.findingVersions!.filter(v => v.sourceKey).map(v => v.sourceKey)).size, 2);
  assert.ok(data.findings.every(f => f.status === "needs_review"));
  assert.notEqual(data.findingVersions![0].contentHash, data.findingVersions![1].contentHash);
});

test("M6 concurrent commits share atomic receipts; new expert versions cause conflict instead of overwrite", async () => {
  const { run, store } = await setup("commit-race");
  const job = await run.runExtraction(org, "commit-race", sessionId, user, {}, { generate: model(proposals()) });
  const results = await Promise.all([run.commitExtraction(org, "commit-race", sessionId, job.id, user), run.commitExtraction(org, "commit-race", sessionId, job.id, user)]);
  assert.ok(results.every(r => r.status === "committed"));
  assert.equal((await store.getCaseForOrg(org, "commit-race"))!.findingVersions!.length, 2);
  await setup("edit-conflict");
  const pending = await run.runExtraction(org, "edit-conflict", sessionId, user, {}, { generate: model(proposals()) });
  const draft = pending.drafts[0];
  await store.createVersion(org, "edit-conflict", draft.finding.id, { ...draft.finding, label: "Concurrent manual version" }, { expectedVersion: 0, userId: user });
  const conflict = await run.commitExtraction(org, "edit-conflict", sessionId, pending.id, user);
  assert.equal(conflict.status, "conflict"); assert.equal(conflict.errorCode, "VERSION_CONFLICT");
  assert.equal((await store.getCaseForOrg(org, "edit-conflict"))!.findings[0].label, "Concurrent manual version");
});

test("M6 missing, overlapping, outside and low-confidence evidence stays unresolved without invented time", async () => {
  const { run, store } = await setup("uncertain", 3);
  const rows = proposals(3);
  rows[0].evidence = [{ tStart: null, tEnd: null, journalSeq: [] }];
  rows[1].evidence = [{ tStart: 100, tEnd: 1200, journalSeq: [2, 3, 9999] }];
  rows[2].evidence = [{ tStart: 200, tEnd: 900, journalSeq: [4, 5] }]; rows[2].confidence = .2;
  const job = await run.runExtraction(org, "uncertain", sessionId, user, {}, { generate: model(rows) });
  assert.equal(job.drafts.length, 3); assert.ok(job.drafts.every(d => d.finding.anchorStatus === "unresolved" && d.finding.anchor === undefined));
  assert.equal(job.proposals[0].evidence[0].tStart, null); assert.equal(job.proposals[1].evidence[0].tEnd, 1200);
  assert.ok(job.drafts[1].issues.includes("overlapping_interval")); assert.ok(job.drafts[1].issues.includes("unknown_journal_reference")); assert.ok(job.drafts[2].issues.includes("low_confidence"));
  await run.commitExtraction(org, "uncertain", sessionId, job.id, user);
  const data = (await store.getCaseForOrg(org, "uncertain"))!;
  for (const version of data.findingVersions!) assert.throws(() => approveVersion(data, version.findingId, version.version, version.contentHash, { id: user, membershipRole: "author" }), /resolved/);
});

test("M6 three silent markers survive empty model output; missing marker IDs never invent an anchor", async () => {
  const { run } = await setup("cardinality", 3);
  const job = await run.runExtraction(org, "cardinality", sessionId, user, {}, { generate: model([]) });
  assert.equal(job.drafts.length, 3); assert.ok(job.drafts.every(d => d.issues.includes("missing_proposal")));
  await setup("foreign-marker", 1);
  const foreign = await run.runExtraction(org, "foreign-marker", sessionId, user, {}, { generate: model([{ ...proposals()[0], markerId: "not-recorded" }]) });
  assert.equal(foreign.drafts.length, 2); assert.ok(foreign.drafts.every(d => d.finding.anchorStatus === "unresolved"));
});

test("M6 authorization, media review, absent key and PHI-bearing prose fail closed before unsafe persistence", async () => {
  const { run, storage } = await setup("gates", 2, false); let calls = 0;
  const generate = async (o: GenerateOptions) => { calls++; return model(proposals())(o); };
  await assert.rejects(run.runExtraction("foreign-org", "gates", sessionId, user, {}, { generate }), /not found/);
  await assert.rejects(run.getExtraction("foreign-org", "gates", sessionId), /not found/);
  await assert.rejects(run.commitExtraction("foreign-org", "gates", sessionId, "missing", user), /not found/);
  await assert.rejects(run.runExtraction(org, "gates", sessionId, user, {}, { generate }), /PHI review/); assert.equal(calls, 0);
  await storage.reviewCapture(org, "gates", sessionId, { pixels: true, audio: true, screen: true });
  const unavailable = await run.runExtraction(org, "gates", sessionId, user);
  assert.equal(unavailable.errorCode, "MODEL_UNAVAILABLE");
  const phi = await run.runExtraction(org, "gates", sessionId, user, { retry: true }, { generate: model([{ ...proposals()[0], description: "PatientName: DIRTY_CANARY" }]) });
  assert.equal(phi.errorCode, "PHI_REVIEW_REQUIRED"); assert.equal(phi.drafts.length, 0); assert.ok(!JSON.stringify(phi).includes("DIRTY_CANARY"));
});

test("M6 explicit group/omit decisions are frozen and logged; later changes cannot silently reuse a result", async () => {
  const { run, store } = await setup("decisions", 3);
  const markerDecisions = [{ kind: "group" as const, markerIds: ["marker-0", "marker-1"], reason: "One synthetic finding" }, { kind: "omit" as const, markerIds: ["marker-2"], reason: "Accidental mark" }];
  const job = await run.runExtraction(org, "decisions", sessionId, user, { markerDecisions }, { generate: model(proposals(3)) });
  assert.equal(job.drafts.length, 1); assert.equal(job.drafts[0].finding.groupedAnchors!.length, 2); assert.deepEqual(job.markerDecisions, markerDecisions);
  assert.deepEqual(await run.runExtraction(org, "decisions", sessionId, user, { markerDecisions }, { generate: model([]) }), job);
  await assert.rejects(run.runExtraction(org, "decisions", sessionId, user, { markerDecisions: [] }, { generate: model([]) }), /frozen marker plan/);
  await store.mutateCase(org, "decisions", data => { data.captureSessions![0].markerDecisions = []; return data; });
  await assert.rejects(run.commitExtraction(org, "decisions", sessionId, job.id, user), /decisions changed/);
});

test("M6 re-extraction snapshots expected versions before model I/O and never overwrites an intervening edit", async () => {
  const { run, store } = await setup("version-race");
  const first = await run.runExtraction(org, "version-race", sessionId, user, {}, { generate: model(proposals()) });
  await run.commitExtraction(org, "version-race", sessionId, first.id, user);
  // A new configured model makes a distinct extraction identity. No real provider call.
  const oldModel = process.env.GEMINI_MODEL; process.env.GEMINI_MODEL = "gemini-3.8-pro";
  try {
    const next = await run.runExtraction(org, "version-race", sessionId, user, {}, { generate: async options => {
      await store.createVersion(org, "version-race", first.drafts[0].finding.id, { label: "Expert edit during model call" }, { expectedVersion: 1, userId: user });
      return model(proposals())(options);
    } });
    assert.notEqual(next.id, first.id); assert.equal(next.drafts[0].expectedVersion, 1);
    assert.equal((await run.commitExtraction(org, "version-race", sessionId, next.id, user)).status, "conflict");
    assert.equal((await store.getCaseForOrg(org, "version-race"))!.findings[0].label, "Expert edit during model call");
  } finally { if (oldModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = oldModel; }
});

test("M6 large retained video uses the mocked Files API while preserving reviewed bytes and frozen model", async () => {
  const bytes = Buffer.alloc(13 * 1024 * 1024, 0x53);
  const { run } = await setup("large-media", 2, true, bytes); let uploads = 0;
  const calls: GenerateOptions[] = [];
  const job = await run.runExtraction(org, "large-media", sessionId, user, {}, { generate: model(proposals(), calls), upload: async input => {
    uploads++; assert.equal(input.mimeType, "video/webm"); assert.deepEqual(Buffer.from(input.bytes), bytes);
    return { uri: "https://generativelanguage.googleapis.com/v1beta/files/synthetic", mimeType: "video/webm", name: "files/synthetic" };
  } });
  assert.equal(job.status, "ready"); assert.equal(uploads, 1);
  assert.equal(calls[0].contents[0].parts[2].fileData!.fileUri, "https://generativelanguage.googleapis.com/v1beta/files/synthetic");
  assert.equal(calls[0].contents[0].parts[1].inlineData!.data, Buffer.from("SYNTHETIC_AUDIO").toString("base64"));
});
