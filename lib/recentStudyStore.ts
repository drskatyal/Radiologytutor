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

import { RECENT_STUDIES_MAX, withRecentStudy, type RecentStudy } from "@flowrad/viewer-core/recentStudies";

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

/** Newest first (entries only: no handle is read). */
export async function listRecentStudies(): Promise<RecentStudy[]> {
  let all: RecentStudy[] = [];
  await tx("readonly", (studies) => {
    const req = studies.getAll();
    req.onsuccess = () => {
      all = (req.result as RecentStudy[]).filter((e) => e && typeof e.key === "string" && typeof e.openedAt === "number");
    };
  });
  return all.sort((a, b) => b.openedAt - a.openedAt);
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
export async function rememberRecentStudy(entry: RecentStudy, handles: readonly FileSystemHandle[]): Promise<void> {
  if (handles.length === 0) return;
  const current = await listRecentStudies();
  const next = withRecentStudy(current, entry, RECENT_STUDIES_MAX);
  const keep = new Set(next.map((e) => e.key));
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

export async function forgetRecentStudy(key: string): Promise<void> {
  await tx("readwrite", (studies, store) => {
    studies.delete(key);
    store.delete(key);
  });
}

export async function clearRecentStudies(): Promise<void> {
  await tx("readwrite", (studies, store) => {
    studies.clear();
    store.clear();
  });
}
