// ============================================================================
// lib/dicomCdn/store.ts  (server only)
//
// Object store for converted series. Two targets behind one interface:
//
//   gcs    Cloud Storage JSON API with the Cloud Run service-account token
//          (lib/gcpAuth.ts) — no HMAC secret to rotate. The SA needs
//          roles/storage.objectAdmin on THIS bucket only.
//   local  A directory (dev laptops, unit tests).
//
// Nothing here makes an object public. Delivery is a signed Cloud CDN prefix
// or the authenticated /api/dicom-cdn/files proxy.
// ============================================================================

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gcpAccessToken } from "../gcpAuth";
import type { StoreTarget } from "./config";

export interface PutOptions {
  contentType: string;
  cacheControl: string;
}

export interface BundleStore {
  put(key: string, body: Uint8Array, opts: PutOptions): Promise<void>;
  /** Null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Bytes [start, end] inclusive. Null when the object does not exist. */
  getRange(key: string, start: number, end: number): Promise<Uint8Array | null>;
  /** Every key under `prefix` (recursive). */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

const GCS = "https://storage.googleapis.com";

function gcsStore(bucket: string): BundleStore {
  const object = (key: string) =>
    `${GCS}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
  const auth = async () => ({ Authorization: `Bearer ${await gcpAccessToken()}` });

  return {
    async put(key, body, opts) {
      // Multipart upload so Cache-Control is set in the same request.
      const boundary = `radlearn${Math.random().toString(36).slice(2)}`;
      const meta = JSON.stringify({
        name: key,
        contentType: opts.contentType,
        cacheControl: opts.cacheControl,
      });
      const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
          `--${boundary}\r\nContent-Type: ${opts.contentType}\r\n\r\n`,
        "utf8"
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      const res = await fetch(
        `${GCS}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=multipart`,
        {
          method: "POST",
          headers: {
            ...(await auth()),
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: Buffer.concat([head, Buffer.from(body.buffer, body.byteOffset, body.byteLength), tail]),
          cache: "no-store",
        }
      );
      if (!res.ok) throw new Error(`GCS put ${key} -> ${res.status} ${await res.text().catch(() => "")}`.trim());
    },
    async get(key) {
      const res = await fetch(`${object(key)}?alt=media`, { headers: await auth(), cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS get ${key} -> ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async getRange(key, start, end) {
      const res = await fetch(`${object(key)}?alt=media`, {
        headers: { ...(await auth()), Range: `bytes=${start}-${end}` },
        cache: "no-store",
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS get ${key} -> ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return res.status === 206 ? bytes : bytes.subarray(start, end + 1);
    },
    async list(prefix) {
      const out: string[] = [];
      let pageToken = "";
      do {
        const params = new URLSearchParams({ prefix, fields: "items(name),nextPageToken" });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await fetch(`${GCS}/storage/v1/b/${encodeURIComponent(bucket)}/o?${params}`, {
          headers: await auth(),
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`GCS list ${prefix} -> ${res.status}`);
        const body = (await res.json()) as { items?: { name: string }[]; nextPageToken?: string };
        for (const item of body.items ?? []) out.push(item.name);
        pageToken = body.nextPageToken ?? "";
      } while (pageToken);
      return out;
    },
    async delete(key) {
      const res = await fetch(object(key), { method: "DELETE", headers: await auth(), cache: "no-store" });
      if (!res.ok && res.status !== 404) throw new Error(`GCS delete ${key} -> ${res.status}`);
    },
  };
}

function localStore(root: string): BundleStore {
  const base = resolve(root);
  const pathFor = (key: string) => {
    const full = resolve(base, key);
    if (full !== base && !full.startsWith(base + sep)) throw new Error("Key escapes the store");
    return full;
  };
  const walk = async (dir: string): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => join((e as { parentPath?: string }).parentPath ?? e.path, e.name));
    } catch {
      return [];
    }
  };
  return {
    async put(key, body) {
      const full = pathFor(key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathFor(key)));
      } catch {
        return null;
      }
    },
    async getRange(key, start, end) {
      try {
        return new Uint8Array(await readFile(pathFor(key))).subarray(start, end + 1);
      } catch {
        return null;
      }
    },
    async list(prefix) {
      const files = await walk(pathFor(prefix.replace(/\/+$/, "")));
      return files.map((f) => relative(base, f).split(sep).join("/"));
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

export function openBundleStore(target: StoreTarget): BundleStore {
  return target.kind === "gcs" ? gcsStore(target.bucket) : localStore(target.dir);
}
