import type { CaptureManifest } from "./types";
import type { CaptureLocalStore, LocalCapture, LocalChunk } from "./localStore";
import { CaptureError, sameChunk } from "./manifest";
import type { CaptureSession } from "../types";

export interface CaptureRemote {
  manifest(local: LocalCapture): Promise<CaptureManifest>;
  put(local: LocalCapture, chunk: LocalChunk): Promise<void>;
  complete(local: LocalCapture): Promise<CaptureSession>;
}
export const captureBase = (caseId: string, id: string) => `/api/cases/${encodeURIComponent(caseId)}/capture-sessions/${encodeURIComponent(id)}`;
async function response<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new CaptureError(typeof body.error === "string" ? body.error : "Capture sync failed", res.status);
  return body;
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const captureRemote: CaptureRemote = {
  async manifest(local) {
    const url = `${captureBase(local.manifest.caseId, local.manifest.sessionId)}/manifest`;
    const res = await fetch(url, { cache: "no-store" });
    return response<CaptureManifest>(res.status === 404 ? await post(url, { action: "start" }) : res);
  },
  async put(local, retained) {
    const receipt = await response(await fetch(`${captureBase(local.manifest.caseId, local.manifest.sessionId)}/chunks/${retained.chunk.seq}`, {
      method: "PUT", headers: { "Content-Type": retained.chunk.mime, "X-Capture-Chunk": JSON.stringify(retained.chunk) }, body: retained.blob,
    }));
    if (!sameChunk(receipt as LocalChunk["chunk"], retained.chunk)) throw new CaptureError("Capture receipt mismatch", 409);
  },
  async complete(local) { return response(await post(`${captureBase(local.manifest.caseId, local.manifest.sessionId)}/manifest`, { action: "complete", manifest: local.manifest })); },
};

/** Server receipts are authoritative, even after a lost response or a browser crash. */
export async function syncCapture(local: LocalCapture, store: CaptureLocalStore, remote: CaptureRemote = captureRemote): Promise<{ missing: number; session?: CaptureSession }> {
  const server = await remote.manifest(local);
  const chunks = (await store.chunks(local.manifest.sessionId)).filter(c => c.chunk.seq < local.manifest.chunks.length);
  if (chunks.length !== local.manifest.chunks.length) throw new CaptureError("Local capture is incomplete; retained data was not deleted", 409);
  for (const receipt of server.chunks) {
    const retained = chunks.find(c => c.chunk.seq === receipt.seq);
    if (!retained || !sameChunk(retained.chunk, receipt)) throw new CaptureError("Local and server capture differ; no data was overwritten", 409);
  }
  let missing = 0;
  for (const chunk of chunks) {
    if (!server.chunks.some(c => c.seq === chunk.chunk.seq)) { missing++; await remote.put(local, chunk); }
    await store.ack(chunk);
  }
  if (!local.closed) return { missing };
  const session = await remote.complete(local);
  local.manifest = session.manifest!; local.synced = true;
  local.track = session.track;
  await store.save(local);
  return { missing, session };
}
