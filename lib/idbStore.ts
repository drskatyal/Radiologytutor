// Minimal IndexedDB key-value stores for this browser only (never synced):
// saved annotations and watched-folder handles. Every call fails soft: a
// private window or blocked storage just means nothing is remembered.

const DB = "flowrad-viewer-local";
const VERSION = 2;
export const STORES = ["annotations", "watchFolders", "captures", "captureChunks"] as const;
export type StoreName = (typeof STORES)[number];

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onblocked = () => reject(new Error("Close older viewer tabs, then retry capture storage."));
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); opening = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  opening.catch(() => (opening = null));
  return opening;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
      })
  );
}

export const idbGet = <T>(store: StoreName, key: string): Promise<T | undefined> => run<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>).catch(() => undefined);
export const idbSet = (store: StoreName, key: string, value: unknown): Promise<void> => run(store, "readwrite", (s) => s.put(value, key)).then(() => undefined, () => undefined);
export const idbDelete = (store: StoreName, key: string): Promise<void> => run(store, "readwrite", (s) => s.delete(key)).then(() => undefined, () => undefined);
export const idbAll = <T>(store: StoreName): Promise<T[]> => run<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>).catch(() => [] as T[]);

/** Capture must fail visibly when storage fails, and wait for transaction commit. */
export async function captureTransaction<T>(stores: StoreName[], mode: IDBTransactionMode, execute: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(stores, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () => reject(new Error("Capture storage failed. Free browser storage and retry; this take has not been saved."));
    try { execute(tx, result => { value = result; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}
