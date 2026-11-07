// Two-tier cache for immutable DICOMweb bodies (frames, rendered thumbnails,
// slim series indexes) behind /api/dicomweb.
//
//   L1  in-process LRU, bounded by bytes (FRAME_MEMORY_CACHE_MB, default 64 — sized for a small container).
//       Zero-latency, per instance. On by default — a single app instance
//       (Railway) gets repeat-open hits even with no bucket configured.
//   L2  the object store (R2, or GCS via R2_ENDPOINT) when configured. Shared
//       across instances and restarts.
//
// Why it matters: a Cloud Healthcare frame costs ~620 ms however many are in
// flight. A cache hit costs one bucket GET (~20–80 ms) or nothing (L1).
//
// Reads are HEDGED by the route, not budgeted: the old 25 ms budget meant a
// real bucket (30–80 ms) almost never won, so the cache was "on" and missed
// every time.

import { getObject, putObject, r2Configured } from "./r2";

export interface CachedBody {
  bytes: Buffer;
  contentType: string;
  tier: "memory" | "object";
}

const MEMORY_BYTES = Math.max(0, Number(process.env.FRAME_MEMORY_CACHE_MB ?? 64)) * 1024 * 1024;

const memory = new Map<string, { bytes: Buffer; contentType: string }>();
let memoryBytes = 0;

function memoryGet(key: string): CachedBody | null {
  const hit = memory.get(key);
  if (!hit) return null;
  // LRU: re-insert at the tail.
  memory.delete(key);
  memory.set(key, hit);
  return { ...hit, tier: "memory" };
}

function memoryPut(key: string, bytes: Buffer, contentType: string): void {
  if (MEMORY_BYTES <= 0 || bytes.length > MEMORY_BYTES / 8) return;
  const prev = memory.get(key);
  if (prev) {
    memoryBytes -= prev.bytes.length;
    memory.delete(key);
  }
  memory.set(key, { bytes, contentType });
  memoryBytes += bytes.length;
  for (const [k, v] of memory) {
    if (memoryBytes <= MEMORY_BYTES) break;
    memory.delete(k);
    memoryBytes -= v.bytes.length;
  }
}

export function frameCacheEnabled(): boolean {
  return MEMORY_BYTES > 0 || r2Configured();
}

/** L1, then L2 (promoting an L2 hit into L1). Never throws. */
export async function cacheGet(key: string): Promise<CachedBody | null> {
  const local = memoryGet(key);
  if (local) return local;
  if (!r2Configured()) return null;
  try {
    const remote = await getObject(key);
    if (!remote) return null;
    memoryPut(key, remote.bytes, remote.contentType);
    return { bytes: remote.bytes, contentType: remote.contentType, tier: "object" };
  } catch {
    return null;
  }
}

/** Write-through. The L2 write is fire-and-forget; failures only cost a future miss. */
export function cachePut(key: string, bytes: Buffer, contentType: string): void {
  memoryPut(key, bytes, contentType);
  if (r2Configured()) void putObject(key, bytes, contentType).catch(() => undefined);
}

/** Tests only. */
export function resetMemoryCache(): void {
  memory.clear();
  memoryBytes = 0;
}
