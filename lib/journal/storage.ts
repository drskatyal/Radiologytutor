import { createHash } from "node:crypto";
import { getCaseForOrg, mutateCase } from "../cases";
import { getCaptureObject, putCaptureObject } from "../durableStore";
import type { CaptureChunk, CaptureManifest, CaptureStream, JournalEntry } from "./types";
import { assertComplete, CaptureError, newManifest, sameChunk, validCaptureId, validateChunk, validateJournal } from "./manifest";
import { trackFromJournal } from "./track";
import type { CaptureSession } from "../types";
import { assertReviewedMedia } from "../phiGuard";

function checkIds(orgId: string, caseId: string, id: string): void {
  if (![orgId, caseId, id].every(validCaptureId)) throw new CaptureError("Invalid capture identity");
}
const objectKey = (orgId: string, caseId: string, id: string, hash: string) => `captures/${orgId}/${caseId}/${id}/${hash}`;
export async function captureSession(orgId: string, caseId: string, id: string): Promise<CaptureSession> {
  checkIds(orgId, caseId, id);
  const data = await getCaseForOrg(orgId, caseId);
  const session = data?.captureSessions?.find(s => s.id === id);
  if (!session?.manifest) throw new CaptureError("Capture session not found", 404);
  return session;
}
export async function startCapture(orgId: string, caseId: string, id: string): Promise<CaptureManifest> {
  checkIds(orgId, caseId, id);
  let result!: CaptureManifest;
  await mutateCase(orgId, caseId, data => {
    data.captureSessions ??= [];
    const existing = data.captureSessions.find(s => s.id === id);
    if (existing && !existing.manifest) throw new CaptureError("Capture session identity already in use", 409);
    result = existing?.manifest ?? newManifest(caseId, id);
    if (!existing) data.captureSessions.push({ id, createdAt: result.createdAt, durationMs: 0, track: { start: { sliceIndex: 0 }, durationMs: 0, events: [] }, manifest: result });
    return data;
  });
  return result;
}
export async function putCaptureChunk(orgId: string, caseId: string, id: string, chunk: CaptureChunk, bytes: Buffer): Promise<CaptureChunk> {
  validateChunk(chunk);
  const session = await captureSession(orgId, caseId, id); // authorization before any object I/O
  if (bytes.length !== chunk.bytes || createHash("sha256").update(bytes).digest("hex") !== chunk.sha256) throw new CaptureError("Capture checksum mismatch");
  const old = session.manifest!.chunks.find(c => c.seq === chunk.seq);
  if (old) { if (!sameChunk(old, chunk)) throw new CaptureError("Capture sequence already contains different bytes or metadata", 409); return old; }
  if (session.manifest!.status === "complete") throw new CaptureError("Capture already complete", 409);
  if (chunk.stream === "journal") {
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new CaptureError("Invalid journal JSON"); }
    const entries = validateJournal(parsed);
    if (entries.some(e => e.t < chunk.tStart || e.t > chunk.tEnd)) throw new CaptureError("Journal clock outside chunk");
  }
  await putCaptureObject(objectKey(orgId, caseId, id, chunk.sha256), bytes, chunk.mime);
  let receipt!: CaptureChunk;
  await mutateCase(orgId, caseId, data => {
    const manifest = data.captureSessions?.find(s => s.id === id)?.manifest;
    if (!manifest) throw new CaptureError("Capture session not found", 404);
    const prior = manifest.chunks.find(c => c.seq === chunk.seq);
    if (prior) {
      if (!sameChunk(prior, chunk)) throw new CaptureError("Capture sequence conflict", 409);
      receipt = prior;
    } else {
      if (manifest.status === "complete") throw new CaptureError("Capture already complete", 409);
      receipt = { seq: chunk.seq, stream: chunk.stream, sha256: chunk.sha256, bytes: chunk.bytes, mime: chunk.mime, tStart: chunk.tStart, tEnd: chunk.tEnd };
      manifest.chunks.push(receipt);
      manifest.chunks.sort((a, b) => a.seq - b.seq);
    }
    return data;
  });
  return receipt;
}

export async function readCaptureChunk(orgId: string, caseId: string, id: string, seq: number): Promise<{ chunk: CaptureChunk; bytes: Buffer }> {
  const session = await captureSession(orgId, caseId, id);
  const chunk = session.manifest!.chunks.find(c => c.seq === seq);
  if (!chunk) throw new CaptureError("Capture chunk not found", 404);
  const bytes = await getCaptureObject(objectKey(orgId, caseId, id, chunk.sha256));
  if (!bytes || bytes.length !== chunk.bytes || createHash("sha256").update(bytes).digest("hex") !== chunk.sha256) throw new CaptureError("Retained capture checksum failed", 409);
  return { chunk, bytes };
}

export async function completeCapture(orgId: string, caseId: string, id: string, proposed: CaptureManifest): Promise<CaptureSession> {
  const session = await captureSession(orgId, caseId, id);
  const journal: JournalEntry[] = [];
  // Verify every retained object, not just the presence of its receipt.
  for (const chunk of session.manifest!.chunks) {
    const retained = await readCaptureChunk(orgId, caseId, id, chunk.seq);
    if (chunk.stream === "journal") journal.push(...validateJournal(JSON.parse(retained.bytes.toString("utf8"))));
  }
  let result!: CaptureSession;
  await mutateCase(orgId, caseId, data => {
    const current = data.captureSessions?.find(s => s.id === id);
    if (!current?.manifest) throw new CaptureError("Capture session not found", 404);
    assertComplete(current.manifest, proposed, journal);
    const manifest: CaptureManifest = { ...current.manifest, status: "complete", durationMs: proposed.durationMs,
      offsets: { audio: proposed.offsets.audio, video: proposed.offsets.video } };
    current.manifest = manifest;
    current.journal = journal;
    current.durationMs = manifest.durationMs;
    current.audioOffsetMs = manifest.offsets.audio; current.videoOffsetMs = manifest.offsets.video;
    current.track = trackFromJournal(journal, manifest);
    result = current;
    return data;
  });
  return result;
}
export async function reviewCapture(orgId: string, caseId: string, id: string, review: CaptureManifest["phiReview"]): Promise<CaptureManifest> {
  assertReviewedMedia(review);
  await captureSession(orgId, caseId, id);
  let result!: CaptureManifest;
  await mutateCase(orgId, caseId, data => {
    const session = data.captureSessions?.find(s => s.id === id);
    if (session?.manifest?.status !== "complete") throw new CaptureError("Complete capture before PHI review", 409);
    session.manifest.phiReview = { pixels: true, audio: true, screen: true };
    result = session.manifest;
    return data;
  });
  return result;
}
export async function captureMedia(orgId: string, caseId: string, id: string, stream: CaptureStream, forModel = false): Promise<{ bytes: Buffer; mimeType: string }> {
  const session = await captureSession(orgId, caseId, id);
  if (session.manifest?.status !== "complete") throw new CaptureError("Complete capture required", 409);
  if (forModel) assertReviewedMedia(session.manifest.phiReview);
  const chunks = session.manifest.chunks.filter(c => c.stream === stream);
  if (!chunks.length) throw new CaptureError("Capture media is missing", 409);
  if (chunks.reduce((n, c) => n + c.bytes, 0) > 96 * 1024 * 1024) throw new CaptureError("Capture media exceeds upload limit", 413);
  const bytes: Buffer[] = [];
  for (const chunk of chunks) bytes.push((await readCaptureChunk(orgId, caseId, id, chunk.seq)).bytes);
  return { bytes: Buffer.concat(bytes), mimeType: chunks[0].mime };
}

export async function retainGeminiVideo(orgId: string, caseId: string, id: string, file: { uri: string; mimeType: string }): Promise<void> {
  await captureSession(orgId, caseId, id);
  if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[a-zA-Z0-9_-]+$/.test(file.uri) || !file.mimeType.startsWith("video/")) throw new CaptureError("Invalid retained video reference");
  await mutateCase(orgId, caseId, data => {
    const session = data.captureSessions?.find(s => s.id === id);
    if (session?.manifest?.status !== "complete") throw new CaptureError("Complete capture required", 409);
    assertReviewedMedia(session.manifest.phiReview);
    session.geminiVideo = { uri: file.uri, mimeType: file.mimeType };
    return data;
  });
}
