// The free viewer's study library, as the desktop's archive: a copy of a
// study's files kept in this browser's private file system (OPFS), so a study
// opened from a disc, a USB stick or a folder that later moves reopens from
// Recent studies without it. Opt-in per study ("Keep in this browser"); the
// copy never leaves the browser and goes with Forget, Clear all and
// "Remember studies I open" off (lib/recentStudyStore).
//
// Layout: <OPFS>/flowrad-library/<recent key>/f0, f1, … and manifest.json
// (each file's path as it was opened, so grouping by folder is unchanged).

const ROOT = "flowrad-library";
const MANIFEST = "manifest.json";

type Dir = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};
type Writable = { write(data: Blob | BufferSource): Promise<void>; close(): Promise<void> };
type WritableFile = FileSystemFileHandle & { createWritable?: () => Promise<Writable> };

async function root(create: boolean): Promise<Dir | null> {
  try {
    const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    if (typeof storage?.getDirectory !== "function") return null;
    return (await (await storage.getDirectory()).getDirectoryHandle(ROOT, { create })) as Dir;
  } catch {
    return null;
  }
}

/** Whether this browser can keep studies (OPFS with writable files). */
export async function studyLibrarySupported(): Promise<boolean> {
  const dir = await root(true);
  if (!dir) return false;
  try {
    const probe = (await dir.getFileHandle(".probe", { create: true })) as WritableFile;
    const ok = typeof probe.createWritable === "function";
    await dir.removeEntry(".probe").catch(() => undefined);
    return ok;
  } catch {
    return false;
  }
}

/** Why a copy could not be kept, for the reader. */
export class KeepStudyError extends Error {}

/**
 * Copy `files` under `key`; resolves with the bytes kept. Checks the browser's
 * quota first (with 10 % headroom); a failed or partial copy is removed.
 */
export async function keepStudy(key: string, files: readonly File[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const bytes = files.reduce((n, f) => n + f.size, 0);
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota != null && estimate.usage != null && estimate.quota - estimate.usage < bytes * 1.1) {
      throw new KeepStudyError(`Not enough space in this browser for ${formatBytes(bytes)}.`);
    }
  } catch (error) {
    if (error instanceof KeepStudyError) throw error;
  }
  const library = await root(true);
  if (!library) throw new KeepStudyError("This browser cannot keep studies.");
  await library.removeEntry(key, { recursive: true }).catch(() => undefined);
  const dir = (await library.getDirectoryHandle(key, { create: true })) as Dir;
  try {
    const manifest: string[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]!;
      const handle = (await dir.getFileHandle(`f${i}`, { create: true })) as WritableFile;
      if (!handle.createWritable) throw new KeepStudyError("This browser cannot keep studies.");
      const w = await handle.createWritable();
      await w.write(file);
      await w.close();
      manifest.push((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
      onProgress?.(i + 1, files.length);
    }
    const m = (await dir.getFileHandle(MANIFEST, { create: true })) as WritableFile;
    const w = await m.createWritable!();
    await w.write(new Blob([JSON.stringify(manifest)], { type: "application/json" }));
    await w.close();
    return bytes;
  } catch (error) {
    await library.removeEntry(key, { recursive: true }).catch(() => undefined);
    if (error instanceof KeepStudyError) throw error;
    throw new KeepStudyError("The copy could not be written (the browser may be out of space).");
  }
}

/** The kept files of `key`, with their original paths; empty when there is no (complete) copy. */
export async function keptStudyFiles(key: string): Promise<File[]> {
  const library = await root(false);
  if (!library) return [];
  try {
    const dir = await library.getDirectoryHandle(key);
    const manifest = JSON.parse(await (await (await dir.getFileHandle(MANIFEST)).getFile()).text()) as unknown;
    if (!Array.isArray(manifest)) return [];
    const out: File[] = [];
    for (let i = 0; i < manifest.length; i += 1) {
      const path = String(manifest[i]);
      const blob = await (await dir.getFileHandle(`f${i}`)).getFile();
      const file = new File([blob], path.split("/").pop() || `f${i}`);
      Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
      out.push(file);
    }
    return out;
  } catch {
    return [];
  }
}

export async function forgetKeptStudy(key: string): Promise<void> {
  const library = await root(false);
  await library?.removeEntry(key, { recursive: true }).catch(() => undefined);
}

export async function clearKeptStudies(): Promise<void> {
  try {
    const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    const top = (await storage.getDirectory?.()) as Dir | undefined;
    await top?.removeEntry(ROOT, { recursive: true }).catch(() => undefined);
  } catch {
    /* nothing kept */
  }
}

/** "263 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
