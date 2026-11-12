import { captureTransaction } from "../idbStore";
import type { CaptureChunk, CaptureManifest } from "./types";
import type { RecordedTrack } from "../types";
export interface LocalCapture { orgId: string; manifest: CaptureManifest; track?: RecordedTrack; closed: boolean; synced: boolean }
export interface LocalChunk { key: string; sessionId: string; chunk: CaptureChunk; blob: Blob; acked: boolean }
export interface CaptureLocalStore {
  save(value: LocalCapture): Promise<void>;
  put(value: LocalCapture, chunk: LocalChunk): Promise<void>;
  get(id: string): Promise<LocalCapture | undefined>;
  list(orgId: string, caseId: string): Promise<LocalCapture[]>;
  chunks(id: string): Promise<LocalChunk[]>;
  ack(chunk: LocalChunk): Promise<void>;
}
export const captureLocalStore: CaptureLocalStore = {
  save: value => captureTransaction(["captures"], "readwrite", tx => { tx.objectStore("captures").put(value, value.manifest.sessionId); }),
  put: (value, chunk) => captureTransaction(["captures", "captureChunks"], "readwrite", tx => {
    tx.objectStore("captures").put(value, value.manifest.sessionId);
    tx.objectStore("captureChunks").put(chunk, chunk.key);
  }),
  get: id => captureTransaction(["captures"], "readonly", (tx, result) => { const req = tx.objectStore("captures").get(id); req.onsuccess = () => result(req.result); }),
  list: (orgId, caseId) => captureTransaction(["captures"], "readonly", (tx, result) => {
    const req = tx.objectStore("captures").getAll(); req.onsuccess = () => result((req.result as LocalCapture[]).filter(c => c.orgId === orgId && c.manifest.caseId === caseId));
  }),
  chunks: id => captureTransaction(["captureChunks"], "readonly", (tx, result) => {
    const req = tx.objectStore("captureChunks").getAll(); req.onsuccess = () => result((req.result as LocalChunk[]).filter(c => c.sessionId === id).sort((a, b) => a.chunk.seq - b.chunk.seq));
  }),
  ack: chunk => captureTransaction(["captureChunks"], "readwrite", tx => { tx.objectStore("captureChunks").put({ ...chunk, acked: true }, chunk.key); }),
};
