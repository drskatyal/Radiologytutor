// Minimal Firestore (Native mode) REST client.
//
// Why REST and not the SDK: the service already authenticates to Google with
// the Cloud Run metadata token (lib/gcpAuth.ts). Reusing it keeps one auth
// path, no gRPC native module in the standalone image, and no new dependency.
// Only what the viewer store needs: get, set, patch, delete, equality query.

import { gcpAccessToken } from "@/lib/gcpAuth";

type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export function toFsValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { nullValue: null };
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFsFields(v as Record<string, unknown>) } };
  throw new Error(`Unsupported Firestore value: ${typeof v}`);
}

export function toFsFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = toFsValue(v);
  return out;
}

export function fromFsValue(v: FsValue): unknown {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromFsValue);
  if ("mapValue" in v) return fromFsFields(v.mapValue.fields ?? {});
  return null;
}

export function fromFsFields(fields: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromFsValue(v);
  return out;
}

export interface FirestoreConfig {
  project: string;
  database: string;
}

export function firestoreConfig(env: NodeJS.ProcessEnv = process.env): FirestoreConfig | null {
  const project = env.FIRESTORE_PROJECT?.trim() || "";
  if (!project) return null;
  return { project, database: env.FIRESTORE_DATABASE?.trim() || "(default)" };
}

export class FirestoreClient {
  private readonly base: string;
  constructor(private readonly cfg: FirestoreConfig) {
    this.base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.project)}/databases/${encodeURIComponent(cfg.database)}/documents`;
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await gcpAccessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return res;
  }

  private docUrl(collection: string, id: string): string {
    return `${this.base}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const res = await this.call(this.docUrl(collection, id));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore get ${collection} -> ${res.status}`);
    const doc = (await res.json()) as { fields?: Record<string, FsValue> };
    return fromFsFields(doc.fields ?? {}) as T;
  }

  /** Create or replace the whole document. `mustNotExist` makes it create-only. */
  async set(collection: string, id: string, data: Record<string, unknown>, mustNotExist = false): Promise<void> {
    const q = mustNotExist ? "?currentDocument.exists=false" : "";
    const res = await this.call(this.docUrl(collection, id) + q, {
      method: "PATCH",
      body: JSON.stringify({ fields: toFsFields(data) }),
    });
    if (!res.ok) throw new Error(`Firestore set ${collection} -> ${res.status}`);
  }

  /** Update only the given top-level fields; the document must exist. */
  async patch(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    const mask = Object.keys(data)
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join("&");
    const res = await this.call(`${this.docUrl(collection, id)}?${mask}&currentDocument.exists=true`, {
      method: "PATCH",
      body: JSON.stringify({ fields: toFsFields(data) }),
    });
    if (!res.ok) throw new Error(`Firestore patch ${collection} -> ${res.status}`);
  }

  async delete(collection: string, id: string): Promise<void> {
    const res = await this.call(this.docUrl(collection, id), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`Firestore delete ${collection} -> ${res.status}`);
  }

  /** Documents where `field == value` (no ordering: callers sort in memory). */
  async whereEqual<T>(collection: string, field: string, value: unknown, limit = 5000): Promise<T[]> {
    const res = await this.call(`${this.base}:runQuery`, {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: collection }],
          where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toFsValue(value) } },
          limit,
        },
      }),
    });
    if (!res.ok) throw new Error(`Firestore query ${collection} -> ${res.status}`);
    const rows = (await res.json()) as { document?: { fields?: Record<string, FsValue> } }[];
    return rows.filter((r) => r.document).map((r) => fromFsFields(r.document!.fields ?? {}) as T);
  }
}
