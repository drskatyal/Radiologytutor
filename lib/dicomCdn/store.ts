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
import { openGcsStore } from "../gcs";
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
  return target.kind === "gcs" ? openGcsStore(target.bucket) : localStore(target.dir);
}
