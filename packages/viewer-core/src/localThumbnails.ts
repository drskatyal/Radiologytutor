// Series thumbnails for the local (no-upload) viewer — the browser half.
//
// One queue per open study. Nothing runs until `start()` — the page calls it
// once the first image is on screen, so thumbnails never compete with it.
// Then one thumbnail at a time, each in an idle slot:
//
//   engine decode (its worker pool, uncached: never evicts a slice the reader
//   is on) → strided sample on main (≤ 256², < 1 ms) → thumbnail worker
//   (window, filter, JPEG) → object URL in a byte-capped LRU.
//
// The raw file the engine's loader parks in its metadata store for the decode
// is dropped again unless the reader's viewport has cached that image, so a
// thumbnail costs only its JPEG (THUMB_BUDGET_BYTES, taken out of the study's
// decoded budget). `dispose()` revokes every URL and ends the worker.

import {
  defaultThumbWindow,
  sampleForThumb,
  THUMB_BUDGET_BYTES,
  THUMB_EDGE,
  ThumbnailCache,
} from "./seriesThumbnail";
import type { ThumbJob, ThumbJobResult } from "./seriesThumbnailWorker";

export type ThumbState = { status: "idle" | "loading" } | { status: "ready"; url: string } | { status: "error" };

export interface LocalThumbnailer {
  /** Current state of a series' thumbnail (sync; for the first render). */
  peek(key: string): ThumbState;
  /** Ask for a thumbnail (row became visible). Resolves when it settles. */
  request(key: string, imageId: string): void;
  /** A row scrolled away before its turn: drop it from the queue. */
  cancel(key: string): void;
  /** Re-render when a state changes. */
  subscribe(listener: (key: string) => void): () => void;
  /** First image is up: begin. */
  start(): void;
  /** JPEG bytes held (numbers only, for the memory gate). */
  bytes(): number;
  dispose(): void;
}

interface EngineImage {
  getPixelData(): ArrayLike<number>;
  columns: number;
  rows: number;
  slope?: number;
  intercept?: number;
  windowCenter?: unknown;
  windowWidth?: unknown;
  invert?: boolean;
  color?: boolean;
}

type Idle = (cb: () => void) => void;
const whenIdle: Idle =
  typeof window !== "undefined" && "requestIdleCallback" in window
    ? (cb) => (window as Window & { requestIdleCallback: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback(cb, { timeout: 400 })
    : (cb) => setTimeout(cb, 16);

export function createLocalThumbnailer(): LocalThumbnailer {
  const cache = new ThumbnailCache(THUMB_BUDGET_BYTES);
  const failed = new Set<string>();
  const queue = new Map<string, string>(); // key → imageId, insertion order = request order
  const listeners = new Set<(key: string) => void>();
  let started = false;
  let running: string | null = null;
  let disposed = false;
  let worker: Worker | null = null;
  let workerBroken = false;
  let seq = 0;
  const waiting = new Map<number, (r: ThumbJobResult) => void>();

  const emit = (key: string) => listeners.forEach((l) => l(key));

  const getWorker = (): Worker | null => {
    if (workerBroken || typeof Worker === "undefined") return null;
    if (worker) return worker;
    try {
      worker = new Worker(new URL("./seriesThumbnailWorker.ts", import.meta.url), { type: "module", name: "flowrad-thumbs" });
      worker.onmessage = (e: MessageEvent<ThumbJobResult>) => {
        const done = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        done?.(e.data);
      };
      worker.onerror = () => {
        workerBroken = true;
        for (const [id, done] of waiting) done({ id, failed: true });
        waiting.clear();
      };
      return worker;
    } catch {
      workerBroken = true;
      return null;
    }
  };

  const encodeOnMain = async (job: ThumbJob): Promise<Blob | null> => {
    const { renderThumbRgba } = await import("./seriesThumbnail");
    const out = renderThumbRgba(job.sample, job.window, job.invert, job.edge);
    return rgbaToJpeg(out.rgba, out.width, out.height);
  };

  const encode = async (job: Omit<ThumbJob, "id">): Promise<Blob | null> => {
    const w = getWorker();
    const id = (seq += 1);
    if (!w) return encodeOnMain({ id, ...job });
    const result = await new Promise<ThumbJobResult>((resolve) => {
      waiting.set(id, resolve);
      w.postMessage({ id, ...job } satisfies ThumbJob, [job.sample.values.buffer]);
    });
    if ("blob" in result) return result.blob;
    if ("rgba" in result) return rgbaToJpeg(result.rgba, result.width, result.height);
    return null;
  };

  const render = async (imageId: string): Promise<Blob | null> => {
    const core = await import("@cornerstonejs/core");
    const wasCached = !!core.cache.getImageLoadObject(imageId);
    const image = (await core.imageLoader.loadImage(imageId)) as unknown as EngineImage;
    if (!wasCached && !core.cache.getImageLoadObject(imageId)) void dropRawFile(imageId);
    const pixels = image.getPixelData();
    const components = Math.max(1, Math.round(pixels.length / Math.max(1, image.columns * image.rows)));
    const sample = sampleForThumb({
      pixelData: pixels,
      columns: image.columns,
      rows: image.rows,
      components,
      slope: image.slope,
      intercept: image.intercept,
    });
    if (!sample) return null;
    const win = defaultThumbWindow(sample, image);
    return encode({ sample, window: win, invert: sample.channels === 1 && !!image.invert, edge: THUMB_EDGE });
  };

  const pump = () => {
    if (!started || running || disposed) return;
    const next = queue.entries().next();
    if (next.done) return;
    const [key, imageId] = next.value;
    queue.delete(key);
    running = key;
    emit(key);
    whenIdle(() => {
      void render(imageId)
        .then((blob) => {
          if (disposed) return;
          if (!blob) failed.add(key);
          else cache.set(key, URL.createObjectURL(blob), blob.size);
        })
        .catch(() => {
          if (!disposed) failed.add(key);
        })
        .finally(() => {
          running = null;
          if (disposed) return;
          emit(key);
          pump();
        });
    });
  };

  return {
    peek(key) {
      const url = cache.get(key);
      if (url) return { status: "ready", url };
      if (failed.has(key)) return { status: "error" };
      if (running === key || queue.has(key)) return { status: "loading" };
      return { status: "idle" };
    },
    request(key, imageId) {
      if (disposed || cache.has(key) || failed.has(key) || running === key || queue.has(key)) return;
      queue.set(key, imageId);
      emit(key);
      pump();
    },
    cancel(key) {
      if (queue.delete(key)) emit(key);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (started) return;
      started = true;
      pump();
    },
    bytes: () => cache.bytes(),
    dispose() {
      disposed = true;
      queue.clear();
      cache.clear();
      listeners.clear();
      worker?.terminate();
      worker = null;
      for (const [id, done] of waiting) done({ id, failed: true });
      waiting.clear();
    },
  };
}

/** Encode RGBA to JPEG on the page (workers without OffscreenCanvas). */
async function rgbaToJpeg(rgba: Uint8ClampedArray, width: number, height: number): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82));
}

/**
 * The loader keeps a decoded file's whole Part 10 bytes in its NATURALIZED
 * metadata store until the decoded image is evicted from the cache. A
 * thumbnail decode is never cached, so nothing would evict it: drop it here.
 * Multi-frame files share one entry with their (possibly cached) frames, so
 * they are left alone.
 */
async function dropRawFile(imageId: string): Promise<void> {
  if (imageId.includes("?") || imageId.includes("frame=")) return;
  try {
    const metadata = await import("@cornerstonejs/metadata");
    const cacheData = metadata.utilities.CacheData as unknown as { clearTypedCacheData(type: string, query?: string): void };
    cacheData.clearTypedCacheData(metadata.Enums.MetadataModules.NATURALIZED, imageId);
  } catch {
    /* nothing held */
  }
}
