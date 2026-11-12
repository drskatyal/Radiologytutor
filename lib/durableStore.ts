// Cloud Run has no durable disk. The JSON-on-volume store is the dev, test,
// and local-demo fallback. A Cloud Run revision (K_SERVICE is set by the
// platform) must use MongoDB via MONGODB_URI from Secret Manager.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertDurableStorageConfigured } from "./envSchema";
import { getObject, putObject, objectStorageConfigured } from "./objectStorage";

/** Immutable content-addressed capture objects; logical receipts live in the case store. */
export async function putCaptureObject(key: string, bytes: Buffer, mime: string): Promise<void> {
  assertCaptureKey(key);
  if (createHash("sha256").update(bytes).digest("hex") !== key.split("/").at(-1)) throw new Error("Capture content checksum mismatch");
  assertDurableStorageConfigured();
  if (objectStorageConfigured()) {
    if (!await putObject(key, bytes, mime)) throw new Error("Capture storage unavailable");
    return;
  }
  const file = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.pending-${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, "wx");
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // The destination appears atomically; a process crash cannot leave a partial object at its digest key.
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
export async function getCaptureObject(key: string): Promise<Buffer | null> {
  assertCaptureKey(key);
  assertDurableStorageConfigured();
  if (objectStorageConfigured()) return (await getObject(key))?.bytes ?? null;
  try { return await fs.readFile(path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), key)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function assertCaptureKey(key: string): void {
  if (!/^captures\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}$/.test(key)) throw new Error("Invalid capture object key");
}

/** Throw when this process is Cloud Run and MONGODB_URI is missing. */
export function assertCloudRunMongo(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.K_SERVICE?.trim()) return;
  if (env.MONGODB_URI?.trim()) return;
  throw new Error(
    "Cloud Run requires MONGODB_URI from Secret Manager. JSON-on-disk is not durable on Cloud Run."
  );
}
