// Where the free viewer's open study came from, so a recovery reload (a new
// build, lib/chunkRecovery.ts) can offer "Reopen study" instead of asking the
// reader to find the folder again.
//
// Stores ONE thing in this browser's IndexedDB: the File System Access
// handle(s) the reader picked or dropped (Chromium). A handle is a
// permission-gated reference, not the files: no pixel or header bytes are
// stored, nothing leaves the browser, and reading it again needs the
// reader's click (`requestPermission`). Cleared on Close study and after a
// reopen. Other browsers have no handles: everything here is a no-op there.

const DB = "flowrad-viewer";
const STORE = "handles";
const KEY = "open-study";

type Handle = FileSystemHandle;

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/** Remember the handles of the study just opened (replaces any earlier one). */
export async function rememberStudyHandles(handles: readonly Handle[]): Promise<void> {
  if (handles.length === 0) return clearStudyHandles();
  await run("readwrite", (store) => store.put([...handles], KEY));
}

export async function recallStudyHandles(): Promise<Handle[]> {
  const value = await run<unknown>("readonly", (store) => store.get(KEY));
  return Array.isArray(value) ? (value as Handle[]) : [];
}

export async function clearStudyHandles(): Promise<void> {
  await run("readwrite", (store) => store.delete(KEY));
}

type Permissioned = Handle & {
  queryPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
};

/**
 * Can every remembered handle be read right now, with no prompt? The reader
 * chose this study before the reload, so when the browser still grants read
 * access the viewer reopens it straight away. Never asks (no prompt, no
 * click needed): `queryPermission` only.
 */
export async function studyHandlesReadable(handles: readonly Handle[]): Promise<boolean> {
  if (handles.length === 0) return false;
  for (const handle of handles as Permissioned[]) {
    try {
      if (typeof handle.queryPermission !== "function") return false;
      if ((await handle.queryPermission({ mode: "read" })) !== "granted") return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Ask (inside a click) to read the remembered handles again. The browser's
 * own prompt shows only where it requires one (access lapsed). Returns them when
 * every one is readable, else an empty list.
 */
export async function regainStudyHandles(handles: readonly Handle[]): Promise<Handle[]> {
  for (const handle of handles as Permissioned[]) {
    try {
      let state = (await handle.queryPermission?.({ mode: "read" })) ?? "denied";
      if (state !== "granted") state = (await handle.requestPermission?.({ mode: "read" })) ?? "denied";
      if (state !== "granted") return [];
    } catch {
      return [];
    }
  }
  return [...handles];
}
