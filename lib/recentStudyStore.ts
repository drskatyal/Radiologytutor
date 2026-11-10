// The free viewer's recent studies (@flowrad/viewer-core/recentStudies), kept
// in this browser's IndexedDB: each entry beside the File System Access
// handle(s) it was opened from, so a click reopens it (Chromium). A handle is
// a permission-gated reference, not the files: no pixel or header bytes are
// stored, nothing leaves the browser, and reading it again needs the reader's
// click (`requestPermission`). Only studies opened from a handle are kept:
// without one there is nothing to reopen. Other browsers: an empty list.
//
// Its own database, so the reload-recovery store (studyHandleStore.ts) keeps
// its schema. Two stores: the entries (what the landing lists) and, apart,
// their handles, read only when the reader clicks one to reopen it. Listing
// never deserialises a handle.
//
// One more record, beside the handles: this browser's random salt for the
// entries' patient keys (recentStudies.ts). It never leaves the browser, so a
// key matches only this browser's own entries. Clearing the list drops it too.

import { RECENT_STUDIES_MAX, withRecentStudy, type RecentStudy } from "@flowrad/viewer-core/recentStudies";
import { clearKeptStudies, forgetKeptStudy } from "@/lib/studyLibrary";

const DB = "flowrad-viewer-recent";
const STORE = "studies";
const HANDLES = "handles";

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "key" });
        req.result.createObjectStore(HANDLES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Run `work` in one transaction; resolves when it commits (false when storage is unavailable). */
async function tx(mode: IDBTransactionMode, work: (studies: IDBObjectStore, handles: IDBObjectStore) => void): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const t = db.transaction([STORE, HANDLES], mode);
      work(t.objectStore(STORE), t.objectStore(HANDLES));
      t.oncomplete = () => {
        db.close();
        resolve(true);
      };
      t.onerror = t.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

/**
 * One operation at a time, in call order. Each runs in its own transaction,
 * and remembering is a read then a write: without this, Forget clicked while a
 * just-reopened study was still being remembered could be undone by that
 * late write (the entry came back).
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);
  queue = run.catch(() => undefined);
  return run;
}

/** Newest first (entries only: no handle is read). */
export function listRecentStudies(): Promise<RecentStudy[]> {
  return serial(readAll);
}

async function readAll(): Promise<RecentStudy[]> {
  let all: RecentStudy[] = [];
  await tx("readonly", (studies) => {
    const req = studies.getAll();
    req.onsuccess = () => {
      all = (req.result as RecentStudy[]).filter((e) => e && typeof e.key === "string" && typeof e.openedAt === "number");
    };
  });
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

/** Where the salt lives in the handles store (no entry key can collide: those are 16 hex digits). */
const SALT_KEY = "salt:patient";

/** This browser's salt for patient keys, made on first use; null when storage is unavailable. */
export function recentStudySalt(): Promise<string | null> {
  return serial(async () => {
    let salt: string | null = null;
    await tx("readonly", (_studies, store) => {
      const req = store.get(SALT_KEY);
      req.onsuccess = () => {
        if (typeof req.result === "string" && req.result.length >= 32) salt = req.result;
      };
    });
    if (salt) return salt;
    if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") return null;
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const saved = await tx("readwrite", (_studies, store) => {
      store.put(fresh, SALT_KEY);
    });
    return saved ? fresh : null;
  });
}

/** The handles to reopen `key` from (read only on the reader's click). */
export async function recentStudyHandles(key: string): Promise<FileSystemHandle[]> {
  let handles: FileSystemHandle[] = [];
  await tx("readonly", (_studies, store) => {
    const req = store.get(key);
    req.onsuccess = () => {
      if (Array.isArray(req.result)) handles = req.result as FileSystemHandle[];
    };
  });
  return handles;
}

/** Put `entry` at the top (replacing the same study) and drop the oldest past the cap. */
export function rememberRecentStudy(entry: RecentStudy, handles: readonly FileSystemHandle[]): Promise<void> {
  if (handles.length === 0) return Promise.resolve();
  return serial(() => remember(entry, handles));
}

async function remember(entry: RecentStudy, handles: readonly FileSystemHandle[]): Promise<void> {
  const current = await readAll();
  // Opened again: a kept copy stays kept.
  const kept = current.find((e) => e.key === entry.key)?.keptBytes;
  if (kept && !entry.keptBytes) entry = { ...entry, keptBytes: kept };
  const next = withRecentStudy(current, entry, RECENT_STUDIES_MAX);
  const keep = new Set(next.map((e) => e.key));
  for (const e of current) if (!keep.has(e.key) && e.keptBytes) void forgetKeptStudy(e.key);
  await tx("readwrite", (studies, store) => {
    for (const e of current) {
      if (keep.has(e.key)) continue;
      studies.delete(e.key);
      store.delete(e.key);
    }
    studies.put(entry);
    store.put([...handles], entry.key);
  });
}

/** Mark `key` as kept in the study library (bytes), or not (undefined). */
export function setRecentStudyKept(key: string, keptBytes: number | undefined): Promise<void> {
  return serial(async () => {
    const entry = (await readAll()).find((e) => e.key === key);
    if (!entry) return;
    await tx("readwrite", (studies) => {
      const next: RecentStudy = { ...entry };
      if (keptBytes) next.keptBytes = keptBytes;
      else delete next.keptBytes;
      studies.put(next);
    });
  });
}

export function forgetRecentStudy(key: string): Promise<void> {
  void forgetKeptStudy(key);
  return serial(async () => {
    await tx("readwrite", (studies, store) => {
      studies.delete(key);
      store.delete(key);
    });
  });
}

export function clearRecentStudies(): Promise<void> {
  void clearKeptStudies();
  return serial(async () => {
    await tx("readwrite", (studies, store) => {
      studies.clear();
      store.clear();
    });
  });
}
