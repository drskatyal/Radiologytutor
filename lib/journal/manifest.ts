import type { CaptureChunk, CaptureManifest, JournalEntry } from "./types";
import { validSnapshot } from "./viewer";
import { assertNoPhi } from "../phiGuard";

export class CaptureError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "CaptureError"; }
}
export function validCaptureId(id: unknown): id is string { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id); }
export function newManifest(caseId: string, sessionId: string, createdAt = new Date().toISOString()): CaptureManifest {
  if (!validCaptureId(caseId) || !validCaptureId(sessionId)) throw new CaptureError("Invalid capture identity");
  return { version: 1, caseId, sessionId, createdAt, status: "recording", chunks: [], durationMs: 0, offsets: {}, phiReview: { pixels: false, audio: false, screen: false } };
}
export function validateChunk(c: CaptureChunk): void {
  if (!c || !Number.isInteger(c.seq) || c.seq < 0 || c.seq > 100000 || !["journal", "audio", "video"].includes(c.stream) ||
    !Number.isInteger(c.bytes) || c.bytes <= 0 || c.bytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(c.sha256) ||
    !Number.isFinite(c.tStart) || !Number.isFinite(c.tEnd) || c.tStart < 0 || c.tEnd < c.tStart || c.tEnd > 24 * 60 * 60 * 1000 ||
    !(c.stream === "journal" ? c.mime === "application/json" : new RegExp(`^${c.stream}/(?:webm|mp4|ogg|wav)(?:;codecs=[a-zA-Z0-9.,-]+)?$`).test(c.mime))) throw new CaptureError("Invalid capture chunk");
}
export const sameChunk = (a: CaptureChunk, b: CaptureChunk): boolean =>
  !!a && !!b && ["seq", "stream", "tStart", "tEnd", "sha256", "bytes", "mime"].every(k => a[k as keyof CaptureChunk] === b[k as keyof CaptureChunk]);

export function validateJournal(input: unknown): JournalEntry[] {
  assertNoPhi(input);
  if (!Array.isArray(input) || !input.length || input.length > 10000) throw new CaptureError("Invalid capture journal");
  for (const e of input) {
    if (!e || !Number.isInteger(e.seq) || e.seq < 0 || !Number.isFinite(e.t) || e.t < 0 ||
      !["render", "input", "marker", "annotation", "measurement", "layout", "discontinuity"].includes(e.kind) ||
      (e.snapshot && !validSnapshot(e.snapshot)) || (e.kind === "render" && (!e.snapshot || e.renderSeq !== e.snapshot.renderSeq))) throw new CaptureError("Invalid journal evidence");
  }
  return input.map(e => ({ seq: e.seq, t: e.t, kind: e.kind, ...(e.snapshot ? { snapshot: e.snapshot } : {}), ...(e.renderSeq !== undefined ? { renderSeq: e.renderSeq } : {}), ...(e.payload ? { payload: e.payload } : {}) }));
}

/** A complete manifest proves the entire global sequence, not only the latest upload. */
export function assertComplete(received: CaptureManifest, proposed: CaptureManifest, journal: JournalEntry[]): void {
  if (!proposed || proposed.version !== 1 || proposed.sessionId !== received.sessionId || proposed.caseId !== received.caseId ||
    !Array.isArray(proposed.chunks) || !proposed.chunks.length || proposed.chunks.length !== received.chunks.length ||
    !Number.isFinite(proposed.durationMs) || proposed.durationMs < 0 || proposed.durationMs > 86400000) throw new CaptureError("Incomplete capture manifest", 409);
  const sorted = [...received.chunks].sort((a, b) => a.seq - b.seq);
  sorted.forEach((c, i) => {
    if (c.seq !== i || !sameChunk(c, proposed.chunks[i]) || c.tEnd > proposed.durationMs) throw new CaptureError("Capture chunk missing or changed", 409);
  });
  for (const stream of ["audio", "video"] as const) {
    const chunks = sorted.filter(c => c.stream === stream);
    const offset = proposed.offsets?.[stream];
    if (chunks.length ? offset !== chunks[0].tStart : offset !== undefined) throw new CaptureError("Media offset does not match retained chunks", 409);
  }
  journal.forEach((entry, i) => {
    if (entry.seq !== i || entry.t > proposed.durationMs || (i > 0 && entry.t < journal[i - 1].t)) throw new CaptureError("Journal sequence is incomplete", 409);
  });
  if (!journal.some(e => e.kind === "render")) throw new CaptureError("Capture has no confirmed render", 409);
}
