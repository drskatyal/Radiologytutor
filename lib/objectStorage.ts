/** GCS first; R2 is optional legacy outside the Healthcare/Cloud Run path. */
import { openGcsStore } from "./gcs";
import { readGcsBucket, requiresCloudStorage } from "./envSchema";
import * as legacy from "./r2";

export function objectStorageConfigured(): boolean {
  return Boolean(readGcsBucket()) || (!requiresCloudStorage() && legacy.r2Configured());
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  const bucket = readGcsBucket();
  if (bucket) {
    await openGcsStore(bucket).put(key, body, { contentType, cacheControl: "private, no-store" });
    return { key, url: null };
  }
  return requiresCloudStorage() ? null : legacy.putObject(key, body, contentType);
}

export async function getObject(key: string) {
  const bucket = readGcsBucket();
  if (bucket) return openGcsStore(bucket).getObject(key);
  return requiresCloudStorage() ? null : legacy.getObject(key);
}
