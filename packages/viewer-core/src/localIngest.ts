"use client";

// Progressive, worker-parallel opening of local DICOM — the free viewer's hot
// path from files dropped to the first image on screen.
//
//   files / folder / .zip / CD
//        │  expand ZIPs (central directory only — zipArchive.ts)
//        │  natural-sort, drop DICOMDIR + obvious junk (no read)
//        ▼
//   one shared queue ──► main-thread lane (until the FIRST image is found)
//                   └──► N lanes → header worker pool (localHeaderWorker.ts)
//        ▼
//   onFirstImage(...)  ← the viewer paints this slice while the rest parse
//        ▼
//   groupLocalStudies(...) → ordered series (localStudy.ts)
//
// Why a main-thread lane: a worker costs a chunk download + boot (~30–80 ms
// cold). The very first header is ~0.2 ms of parse on the main thread with the
// parser already prewarmed, so slice 1 does not wait for the pool. After that
// the main thread only registers `File` handles; every header parse runs in a
// worker, so a 2 000-file CD never freezes the dropzone.
//
// Privacy: nothing here touches the network or the console. File handles are
// registered with Cornerstone's in-memory `fileManager`; pixel bytes are read
// off disk on demand by the decode workers. `releaseLocalImages` drops every
// handle and decoded frame when the study is closed.

import { HEADER_BYTES, parseLocalHeaderProgressive, type DicomHeaderParser } from "./localHeader";
import type { HeaderJob, HeaderJobResult } from "./localHeaderWorker";
import { loadHeaderParser, type LocalOpenProgress, type LocalOpenResult } from "./localDicomFiles";
import {
  compareFileNames,
  groupLocalStudies,
  imageIdsForInstance,
  instanceImageCount,
  isDicomDir,
  isObviouslyNotDicom,
  type LocalInstanceHeader,
} from "./localStudy";
import { listZipFile, looksLikeZipName } from "./zipArchive";

export { HEADER_BYTES };

/** One thing to inspect: a loose file, or an entry of a dropped ZIP. */
interface IngestItem {
  path: string;
  size: number;
  open: () => Promise<File>;
}

export interface FirstLocalImage {
  /** Path of the instance, the key into `imageIdsByFile`. */
  fileName: string;
  /** Its imageIds (one, or one per frame). */
  imageIds: string[];
  header: LocalInstanceHeader;
}

export interface LocalIngestResult extends LocalOpenResult {
  /** The instance that was painted first, so the viewer can keep it on screen. */
  first: FirstLocalImage | null;
  /** ZIP archives that were expanded. */
  zipCount: number;
  /** Every `dicomfile:` base id registered — what `releaseLocalImages` frees. */
  registeredIds: string[];
  /** Wall time from call to grouped result, ms. Numbers only, never names. */
  elapsedMs: number;
}

export interface IngestOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LocalOpenProgress) => void;
  /** Fires once, as soon as one DICOM image is registered and paintable. */
  onFirstImage?: (first: FirstLocalImage) => void;
  /** Header workers. Default: cores − 1, clamped to 1…4. */
  workerCount?: number;
}

type FileManager = { add(file: File): string; remove(index: number): void };

let fileManagerPromise: Promise<FileManager> | null = null;
function loadFileManager(): Promise<FileManager> {
  fileManagerPromise ??= import("@cornerstonejs/dicom-image-loader").then(
    (module) => (module.default ?? module).wadouri.fileManager as unknown as FileManager
  );
  return fileManagerPromise;
}

// --- header worker pool -----------------------------------------------------

function defaultWorkerCount(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, cores - 1));
}

class HeaderWorkerPool {
  private workers: { worker: Worker; inflight: number }[] = [];
  private pending = new Map<number, { resolve: (r: HeaderJobResult) => void; reject: (e: Error) => void; slot: number }>();
  private nextId = 1;
  broken = false;

  constructor(size: number) {
    try {
      for (let i = 0; i < size; i += 1) {
        const worker = new Worker(new URL("./localHeaderWorker.ts", import.meta.url), {
          type: "module",
          name: "flowrad-dicom-header",
        });
        const slot = this.workers.length;
        worker.onmessage = (event: MessageEvent<HeaderJobResult>) => {
          const job = this.pending.get(event.data.id);
          if (!job) return;
          this.pending.delete(event.data.id);
          this.workers[slot].inflight -= 1;
          job.resolve(event.data);
        };
        worker.onerror = (event) => {
          event.preventDefault();
          this.fail();
        };
        this.workers.push({ worker, inflight: 0 });
      }
    } catch {
      this.fail();
    }
  }

  get size(): number {
    return this.workers.length;
  }

  private fail(): void {
    this.broken = true;
    for (const [id, job] of this.pending) {
      this.pending.delete(id);
      job.reject(new Error("header worker unavailable"));
    }
  }

  parse(file: File, name: string): Promise<HeaderJobResult> {
    if (this.broken || this.workers.length === 0) {
      return Promise.reject(new Error("header worker unavailable"));
    }
    let slot = 0;
    for (let i = 1; i < this.workers.length; i += 1) {
      if (this.workers[i].inflight < this.workers[slot].inflight) slot = i;
    }
    const id = this.nextId++;
    this.workers[slot].inflight += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, slot });
      const job: HeaderJob = { id, file, name };
      this.workers[slot].worker.postMessage(job);
    });
  }

  terminate(): void {
    this.fail();
    for (const { worker } of this.workers) worker.terminate();
    this.workers = [];
  }
}

let pool: HeaderWorkerPool | null = null;
function headerPool(size: number): HeaderWorkerPool | null {
  if (typeof Worker === "undefined") return null;
  if (pool && !pool.broken && pool.size === size) return pool;
  pool?.terminate();
  pool = new HeaderWorkerPool(size);
  return pool.broken ? null : pool;
}

/**
 * Warm everything the first drop needs while the user is still choosing a
 * folder: the header parser (main-thread lane), the worker pool (their chunk
 * download + boot), and the Cornerstone file manager. Idempotent.
 */
export function prewarmLocalIngest(): void {
  void loadHeaderParser().catch(() => undefined);
  void loadFileManager().catch(() => undefined);
  headerPool(defaultWorkerCount());
}

// --- input expansion ----------------------------------------------------------

function pathOf(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

async function expandInputs(
  files: readonly File[],
  warnings: string[]
): Promise<{ items: IngestItem[]; zipCount: number }> {
  const items: IngestItem[] = [];
  let zipCount = 0;
  for (const file of files) {
    const path = pathOf(file);
    if (!looksLikeZipName(path)) {
      items.push({ path, size: file.size, open: async () => file });
      continue;
    }
    try {
      const listing = await listZipFile(file, path);
      zipCount += 1;
      for (const entry of listing.entries) {
        items.push({ path: entry.path, size: entry.size, open: entry.open });
      }
      if (listing.unsupported > 0) {
        warnings.push(
          `${listing.unsupported} entr${listing.unsupported === 1 ? "y" : "ies"} in ${file.name} could not be opened (encrypted, or a compression this browser cannot read).`
        );
      }
    } catch {
      warnings.push(`${file.name} is not a readable ZIP archive.`);
    }
  }
  return { items, zipCount };
}

// --- ingest -------------------------------------------------------------------

/**
 * Open local files (any mix of loose files, folders, ZIPs, a CD) into studies.
 * See the module header for the pipeline. Never uploads, never logs.
 */
export async function ingestLocalFiles(
  files: readonly File[],
  options: IngestOptions = {}
): Promise<LocalIngestResult> {
  const started = performance.now();
  const { signal } = options;
  const warnings: string[] = [];

  const [parser, fileManager, expanded] = await Promise.all([
    loadHeaderParser(),
    loadFileManager(),
    expandInputs(files, warnings),
  ]);
  const { zipCount } = expanded;

  let skipped = 0;
  let dicomDirCount = 0;
  const queue: IngestItem[] = [];
  for (const item of expanded.items) {
    if (isDicomDir(item.path)) {
      dicomDirCount += 1;
    } else if (isObviouslyNotDicom(item.path)) {
      skipped += 1;
    } else {
      queue.push(item);
    }
  }
  // Natural order, so lanes read a series front to back.
  queue.sort((a, b) => compareFileNames(a.path, b.path));
  // The viewer opens a stack on its middle slice (the teaching viewer's
  // policy). Parse the natural-order middle file first: on media named in
  // slice order (IM000001…) it IS that slice, so the preview painted now and
  // the ordered stack swapped in later show the same image — no jump.
  if (queue.length > 2) {
    const [middle] = queue.splice(Math.floor(queue.length / 2), 1);
    queue.unshift(middle);
  }

  const total = expanded.items.length;
  const headers: LocalInstanceHeader[] = [];
  const imageIdsByFile = new Map<string, string[]>();
  const registeredIds: string[] = [];
  // A holder, not a `let`: lanes assign it across awaits, which TS flow
  // analysis would otherwise narrow away.
  const found: { first: FirstLocalImage | null } = { first: null };
  let read = skipped + dicomDirCount;
  let unreadable = 0;

  let lastProgressAt = 0;
  const progress = (force = false) => {
    const now = performance.now();
    if (!force && now - lastProgressAt < 60) return;
    lastProgressAt = now;
    options.onProgress?.({ read, accepted: headers.length, total });
  };
  progress(true);

  const accept = (file: File, header: LocalInstanceHeader) => {
    const baseImageId = fileManager.add(file);
    registeredIds.push(baseImageId);
    const ids = imageIdsForInstance(baseImageId, instanceImageCount(header));
    imageIdsByFile.set(header.fileName, ids);
    headers.push(header);
    if (!found.first) {
      found.first = { fileName: header.fileName, imageIds: ids, header };
      options.onFirstImage?.(found.first);
    }
  };

  const parseOnMain = (file: File, path: string) =>
    parseLocalHeaderProgressive(parser as DicomHeaderParser, path, file.size, async (end) =>
      new Uint8Array(await file.slice(0, end).arrayBuffer())
    );

  const workers = headerPool(options.workerCount ?? defaultWorkerCount());
  let cursor = 0;

  const handle = async (item: IngestItem, onMain: boolean) => {
    let file: File;
    try {
      file = await item.open();
    } catch {
      unreadable += 1;
      read += 1;
      progress();
      return;
    }
    let header: LocalInstanceHeader | null = null;
    try {
      if (onMain || !workers || workers.broken) {
        header = await parseOnMain(file, item.path);
      } else {
        try {
          const result = await workers.parse(file, item.path);
          if (result.failed) unreadable += 1;
          header = result.header;
        } catch {
          header = await parseOnMain(file, item.path);
        }
      }
    } catch {
      unreadable += 1;
    }
    read += 1;
    if (signal?.aborted) return;
    if (header) accept(file, header);
    else skipped += 1;
    progress();
  };

  // The first header gets the disk to itself: worker lanes start once the
  // main lane has handled its first item, so the read that decides time to
  // first image never queues behind eight others.
  let releaseWorkers: () => void = () => {};
  const workersMayStart = new Promise<void>((resolve) => {
    releaseWorkers = resolve;
  });
  // Main-thread lane: only until the first image exists.
  const mainLane = async () => {
    try {
      while (!found.first && cursor < queue.length && !signal?.aborted) {
        await handle(queue[cursor++], true);
        releaseWorkers();
      }
    } finally {
      releaseWorkers();
    }
  };
  // Worker lanes: two jobs in flight per worker hides postMessage latency.
  const workerLane = async () => {
    while (cursor < queue.length && !signal?.aborted) {
      await handle(queue[cursor++], false);
    }
  };
  const laneCount = workers ? workers.size * 2 : 1;
  const main = mainLane();
  await workersMayStart;
  await Promise.all([main, ...Array.from({ length: laneCount }, workerLane)]);
  progress(true);

  if (unreadable > 0) {
    warnings.push(`${unreadable} file${unreadable === 1 ? "" : "s"} could not be read.`);
  }
  if (headers.length === 0 && dicomDirCount > 0) {
    warnings.push(
      "This is a DICOM CD index (DICOMDIR) with no images beside it — open the whole disc or the folder that contains the image files."
    );
  }

  return {
    studies: groupLocalStudies(headers),
    imageIdsByFile,
    skipped,
    dicomDirCount,
    warnings,
    first: found.first,
    zipCount,
    registeredIds,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/**
 * Free a closed study: every decoded frame and parsed dataset in the
 * Cornerstone caches, and every `File` handle. Index slots are cleared, not
 * reused, so a later study can never alias a freed imageId.
 */
export async function releaseLocalImages(registeredIds: readonly string[]): Promise<void> {
  const [core, loader] = await Promise.all([
    import("@cornerstonejs/core"),
    import("@cornerstonejs/dicom-image-loader"),
  ]);
  try {
    core.cache.purgeCache();
  } catch {
    /* engine not initialised: nothing cached */
  }
  const wadouri = (loader.default ?? loader).wadouri as unknown as {
    fileManager: FileManager;
    dataSetCacheManager?: { purge(): void };
  };
  wadouri.dataSetCacheManager?.purge();
  for (const id of registeredIds) {
    const index = Number(id.slice("dicomfile:".length));
    if (Number.isInteger(index)) wadouri.fileManager.remove(index);
  }
}
