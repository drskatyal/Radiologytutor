// ============================================================================
// lib/dicomCdn/client.ts  (browser only)
//
// One converted series on the client: asks /api/dicom-cdn/manifest whether a
// bundle exists, then pulls its chunks in reading order —
//
//   preview chunk under the open slice  → instant 8-bit paint + its metadata
//   full chunk under the open slice     → swaps in the 16-bit frame
//   outward from the slice the reader is on (re-planned on every scroll),
//   previews of the whole stack early (they are ~1/20 of the bytes),
//   then the rest.
//
// Each chunk is read from the device cache first (lib/dicomCdn/deviceCache.ts)
// and from the network otherwise. A failed or expired fetch refreshes the
// signed prefix once; anything else rejects and the Cornerstone bridge falls
// back to DICOMweb for that slice. Encoded full frames are held in memory up
// to a budget and re-read from the device on demand.
// ============================================================================

import {
  bundleOpenIndex,
  chunkOrdinalFor,
  entryBytes,
  isUsableIndex,
  planFetchOrder,
  unpackContainer,
  type BundleEntry,
  type BundleHeader,
  type SeriesBundleIndex,
} from "./format";
import { openDeviceSeriesCache, type DeviceSeriesCache } from "./deviceCache";

interface Delivery {
  base: string;
  query: string;
  mode: "cdn" | "proxy";
  expiresAt: number;
}

type ManifestResponse =
  | { available: true; index: SeriesBundleIndex; delivery: Delivery }
  | { available: false; reason: string };

export interface FullFrame {
  bytes: Uint8Array;
  transferSyntaxUID: string;
}

export interface PreviewFrame {
  jpeg: Uint8Array;
  w: number;
  h: number;
  lo: number;
  hi: number;
}

type Listener = (kind: "preview" | "full", indexes: number[]) => void;

const CONCURRENCY = 4;
const MANIFEST_TIMEOUT_MS = 2_500;

function fullMemoryBudget(): number {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return phone || (memory != null && memory <= 4) ? 48 * 1024 * 1024 : 160 * 1024 * 1024;
}

/**
 * Per-browser A/B switch for measurement (docs/DICOM_CDN_REPORT.md):
 * `?dicomcdn=off` (or `=on`) on any page sets it for this browser;
 * localStorage `radlearn:dicomcdn` = "off" keeps DICOMweb until cleared.
 */
function disabledInThisBrowser(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("dicomcdn");
    if (param === "off" || param === "on") window.localStorage.setItem("radlearn:dicomcdn", param);
    // `on` also forgets a remembered "server says off" for this tab.
    if (param === "on") window.sessionStorage.removeItem("radlearn:dicomcdn-server-off");
    return window.localStorage.getItem("radlearn:dicomcdn") === "off";
  } catch {
    return false;
  }
}

export function bundleSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !disabledInThisBrowser() &&
    typeof DecompressionStream !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipJson<T>(bytes: Uint8Array): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await gunzip(bytes))) as T;
}

type Manifest = { index: SeriesBundleIndex; delivery: Delivery };

/**
 * One manifest answer per series per page, shared by the case-page warm
 * (warmBundleOpening) and the viewer. Kept until shortly before its signature
 * expires; an "unavailable" answer is kept for a minute.
 */
const manifests = new Map<string, { at: number; until: number; value: Promise<Manifest | null> }>();

/**
 * When the server says the feature is off ("disabled"), remember it for this
 * tab session so later opens skip the manifest round trip entirely and the
 * DICOMweb path pays nothing for this feature existing.
 */
const OFF_KEY = "radlearn:dicomcdn-server-off";
let serverOff: boolean | null = null;

function serverSaidOff(): boolean {
  if (serverOff == null) {
    try {
      serverOff = window.sessionStorage.getItem(OFF_KEY) === "1";
    } catch {
      serverOff = false;
    }
  }
  return serverOff;
}

function rememberServerOff(): void {
  serverOff = true;
  try {
    window.sessionStorage.setItem(OFF_KEY, "1");
  } catch {
    /* private mode — the in-memory flag still holds for this page */
  }
}

async function requestManifest(study: string, series: string): Promise<Manifest | null> {
  if (serverSaidOff()) return null;
  const timeout = AbortSignal.timeout?.(MANIFEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `/api/dicom-cdn/manifest?study=${encodeURIComponent(study)}&series=${encodeURIComponent(series)}`,
      { credentials: "same-origin", cache: "no-store", signal: timeout }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as ManifestResponse;
    if (!body.available && body.reason === "disabled") rememberServerOff();
    if (!body.available || !isUsableIndex(body.index)) return null;
    return { index: body.index, delivery: body.delivery };
  } catch {
    return null;
  }
}

/** Ask the app whether this series has a bundle. Null → use DICOMweb. */
export async function fetchSeriesManifest(
  study: string,
  series: string,
  signal?: AbortSignal,
  opts: { fresh?: boolean } = {}
): Promise<Manifest | null> {
  if (!bundleSupported()) return null;
  const key = `${study}|${series}`;
  const now = Date.now();
  let hit = manifests.get(key);
  if (!hit || opts.fresh || now > hit.until) {
    const value = requestManifest(study, series);
    hit = { at: now, until: now + 60_000, value };
    manifests.set(key, hit);
    const entry = hit;
    void value.then((m) => {
      if (m) entry.until = Math.min(entry.at + 30 * 60_000, m.delivery.expiresAt - 60_000);
    });
  }
  const value = hit.value;
  if (!signal) return value;
  return Promise.race([
    value,
    new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })),
  ]);
}

// --- shared fetch + warm stash ---------------------------------------------

/**
 * Bytes fetched ahead of the viewer (case-page warm), keyed
 * `{study}/{series}/{version}/{file}` or `…#{sliceIndex}` for a single frame.
 * The viewer's bundle takes them over instead of fetching again.
 */
const stash = new Map<string, Promise<Uint8Array | null>>();

function fileUrl(delivery: Delivery, file: string): string {
  return `${delivery.base}${file}${delivery.query ? `?${delivery.query}` : ""}`;
}

function fetchFile(delivery: Delivery, file: string, range?: [number, number]): Promise<Response> {
  return fetch(fileUrl(delivery, file), {
    // CDN chunks are cross-origin and signed in the URL; send no cookies.
    credentials: delivery.mode === "proxy" ? "same-origin" : "omit",
    mode: delivery.mode === "proxy" ? "same-origin" : "cors",
    cache: "default",
    ...(range ? { headers: { Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } } : {}),
  });
}

/** Body of a (possibly ranged) response; a server that ignored Range gets sliced. */
async function rangeBody(res: Response, range: [number, number]): Promise<Uint8Array> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (res.status === 206) return bytes.subarray(0, range[1]);
  return bytes.subarray(range[0], range[0] + range[1]);
}

function frameRange(index: SeriesBundleIndex, slice: number): { file: string; range: [number, number]; ts: string } | null {
  const ordinal = chunkOrdinalFor(index.frames.chunks, slice);
  const chunk = index.frames.chunks[ordinal];
  const r = chunk?.ranges?.[slice - chunk.start];
  if (!chunk || !r) return null;
  return { file: chunk.file, range: [r[0], r[1]], ts: r[2] ?? index.frames.transferSyntaxUID };
}

/**
 * Case-page warm: while the viewer's JavaScript is still downloading, fetch
 * the manifest, the preview chunk under the opening slice, and the opening
 * slice's full frame. Resolves true when the series has a bundle (the
 * DICOMweb warm is then skipped), false otherwise.
 */
export async function warmBundleOpening(input: {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID?: string;
  sliceIndex?: number;
}): Promise<boolean> {
  const manifest = await fetchSeriesManifest(input.studyInstanceUID, input.seriesInstanceUID);
  if (!manifest) return false;
  const { index, delivery } = manifest;
  const open = bundleOpenIndex(index.sops, input);
  const base = `${index.studyInstanceUID}/${index.seriesInstanceUID}/${index.version}/`;
  const device = openDeviceSeriesCache(index.studyInstanceUID, index.seriesInstanceUID);

  const previewOrdinal = chunkOrdinalFor(index.previews.chunks, open);
  const previewFile = index.previews.chunks[previewOrdinal]?.file;
  if (previewFile && !stash.has(base + previewFile)) {
    stash.set(
      base + previewFile,
      (async () => {
        const cached = await device.get(`${index.version}/${previewFile}`);
        if (cached) return cached;
        const res = await fetchFile(delivery, previewFile);
        if (!res.ok) return null;
        const bytes = new Uint8Array(await res.arrayBuffer());
        void device.put(`${index.version}/${previewFile}`, bytes);
        return bytes;
      })().catch(() => null)
    );
  }
  const frame = frameRange(index, open);
  if (frame && !stash.has(`${base}${frame.file}#${open}`)) {
    stash.set(
      `${base}${frame.file}#${open}`,
      (async () => {
        if (await device.get(`${index.version}/${frame.file}`)) return null; // whole chunk is local
        const res = await fetchFile(delivery, frame.file, frame.range);
        return res.ok ? rangeBody(res, frame.range) : null;
      })().catch(() => null)
    );
  }
  return true;
}

function takeStash(key: string): Promise<Uint8Array | null> | null {
  const hit = stash.get(key);
  if (hit) stash.delete(key);
  return hit ?? null;
}

export class SeriesBundle {
  readonly index: SeriesBundleIndex;
  private delivery: Delivery;
  private readonly device: DeviceSeriesCache;
  private readonly previews = new Map<number, PreviewFrame | null>();
  private readonly full = new Map<number, FullFrame>();
  private fullBytes = 0;
  private readonly fullBudget = fullMemoryBudget();
  private readonly meta = new Map<number, unknown>();
  private allMeta: Promise<unknown[]> | null = null;
  private readonly fetched = { preview: new Set<number>(), full: new Set<number>() };
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<Listener>();
  private current: number;
  private active = 0;
  private disposed = false;
  private refreshing: Promise<boolean> | null = null;
  /** Bytes pulled over the network vs served from the device (for the report). */
  readonly stats = { networkBytes: 0, deviceBytes: 0, chunks: 0 };

  constructor(index: SeriesBundleIndex, delivery: Delivery, openIndex: number) {
    this.index = index;
    this.delivery = delivery;
    this.current = openIndex;
    this.device = openDeviceSeriesCache(index.studyInstanceUID, index.seriesInstanceUID);
  }

  /** Slice the reader is on (last focus). */
  get currentIndex(): number {
    return this.current;
  }

  get count(): number {
    return this.index.sops.length;
  }

  openIndexFor(hint?: { sopInstanceUID?: string; sliceIndex?: number } | null): number {
    return bundleOpenIndex(this.index.sops, hint);
  }

  onFrames(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Where the reader is, without starting background fetches yet. */
  setCurrent(index: number): void {
    this.current = Math.max(0, Math.min(this.count - 1, Math.round(index)));
  }

  /** The reader moved. Re-plan so the chunks around `index` go next. */
  focus(index: number): void {
    if (this.disposed) return;
    this.current = Math.max(0, Math.min(this.count - 1, Math.round(index)));
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.full.clear();
    this.previews.clear();
  }

  hasFull(index: number): boolean {
    return this.full.has(index);
  }

  /** The preview chunk for this slice has arrived (the slice may still have no JPEG). */
  hasPreviewChunk(index: number): boolean {
    return this.previews.has(index);
  }

  preview(index: number): PreviewFrame | null {
    return this.previews.get(index) ?? null;
  }

  metadataFor(index: number): unknown | undefined {
    return this.meta.get(index);
  }

  /** Preview chunk (with metadata) for one slice, from device or network. */
  async ensurePreviewChunk(index: number): Promise<void> {
    if (this.previews.has(index)) return;
    const ordinal = chunkOrdinalFor(this.index.previews.chunks, index);
    if (ordinal < 0) throw new Error(`No preview chunk for slice ${index}`);
    await this.load("preview", ordinal);
  }

  /** Full frame for one slice. Re-reads an evicted chunk from the device. */
  async fullFrame(index: number): Promise<FullFrame> {
    const hit = this.full.get(index);
    if (hit) return hit;
    const ordinal = chunkOrdinalFor(this.index.frames.chunks, index);
    if (ordinal < 0) throw new Error(`No full chunk for slice ${index}`);
    await this.load("full", ordinal);
    const frame = this.full.get(index);
    if (!frame) throw new Error(`Slice ${index} missing from its chunk`);
    return frame;
  }

  /** Whole-series metadata (one gzip document), in stack order. */
  allMetadata(): Promise<unknown[]> {
    if (!this.allMeta) {
      this.allMeta = this.readFile(this.index.meta.file).then((bytes) => gunzipJson<unknown[]>(bytes));
      this.allMeta.then(
        (list) => list.forEach((m, i) => this.meta.set(i, m)),
        () => {
          this.allMeta = null;
        }
      );
    }
    return this.allMeta;
  }

  /** Start background fetching from the current slice outward. */
  start(): void {
    this.pump();
  }

  private pump(): void {
    if (this.disposed) return;
    const plan = planFetchOrder(this.index, this.current, this.fetched);
    for (const step of plan) {
      if (this.active >= CONCURRENCY) return;
      const key = `${step.kind}:${step.ordinal}`;
      if (this.inflight.has(key)) continue;
      this.active += 1;
      void this.load(step.kind, step.ordinal)
        .catch(() => {
          // Mark it fetched so the pump moves on; the loader will retry this
          // chunk on demand, and DICOMweb covers it if that fails too.
          (step.kind === "preview" ? this.fetched.preview : this.fetched.full).add(step.ordinal);
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  /** Fetch + parse one chunk. In-flight requests for the same chunk are shared. */
  private load(kind: "preview" | "full", ordinal: number): Promise<void> {
    const key = `${kind}:${ordinal}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const chunk = (kind === "preview" ? this.index.previews.chunks : this.index.frames.chunks)[ordinal];
    const work = (async () => {
      const bytes = await this.readFile(chunk.file);
      if (this.disposed) return;
      const { gzHeader, payload } = unpackContainer(bytes);
      const header = await gunzipJson<BundleHeader>(gzHeader);
      if (header.kind !== kind) throw new Error("Chunk kind mismatch");
      const indexes: number[] = [];
      if (kind === "preview") {
        header.entries.forEach((entry: BundleEntry, k: number) => {
          if (entry.i < 0 || entry.i >= this.count || this.index.sops[entry.i] !== entry.sop) return;
          if (header.meta?.[k] && !this.meta.has(entry.i)) this.meta.set(entry.i, header.meta[k]);
          this.previews.set(
            entry.i,
            entry.len > 0 && entry.w && entry.h && entry.lo != null && entry.hi != null
              ? { jpeg: entryBytes(payload, entry).slice(), w: entry.w, h: entry.h, lo: entry.lo, hi: entry.hi }
              : null
          );
          indexes.push(entry.i);
        });
        this.fetched.preview.add(ordinal);
      } else {
        for (const entry of header.entries) {
          if (entry.i < 0 || entry.i >= this.count || this.index.sops[entry.i] !== entry.sop) continue;
          if (!this.full.has(entry.i)) {
            const frame = entryBytes(payload, entry).slice();
            this.full.set(entry.i, {
              bytes: frame,
              transferSyntaxUID: entry.ts || this.index.frames.transferSyntaxUID,
            });
            this.fullBytes += frame.byteLength;
          }
          indexes.push(entry.i);
        }
        this.fetched.full.add(ordinal);
        this.evictFull();
      }
      for (const listener of this.listeners) {
        try {
          listener(kind, indexes);
        } catch {
          /* a listener must not break delivery */
        }
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  /** Drop encoded full frames farthest from the reader once over budget. */
  private evictFull(): void {
    if (this.fullBytes <= this.fullBudget) return;
    const byDistance = [...this.full.keys()].sort(
      (a, b) => Math.abs(b - this.current) - Math.abs(a - this.current)
    );
    for (const i of byDistance) {
      if (this.fullBytes <= this.fullBudget * 0.85) break;
      if (Math.abs(i - this.current) <= 16) break;
      const frame = this.full.get(i);
      if (!frame) continue;
      this.full.delete(i);
      this.fullBytes -= frame.bytes.byteLength;
    }
  }

  private stashKey(file: string): string {
    return `${this.index.studyInstanceUID}/${this.index.seriesInstanceUID}/${this.index.version}/${file}`;
  }

  private async readFile(file: string): Promise<Uint8Array> {
    const warmed = await takeStash(this.stashKey(file));
    if (warmed) {
      this.stats.networkBytes += warmed.byteLength;
      this.stats.chunks += 1;
      return warmed;
    }
    const devicePath = `${this.index.version}/${file}`;
    const cached = await this.device.get(devicePath);
    if (cached) {
      this.stats.deviceBytes += cached.byteLength;
      this.stats.chunks += 1;
      return cached;
    }
    let res = await this.fetchChunk(file);
    if ((res.status === 403 || res.status === 401) && (await this.refreshDelivery())) {
      res = await this.fetchChunk(file);
    }
    if (!res.ok) throw new Error(`Chunk ${file} -> ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.stats.networkBytes += bytes.byteLength;
    this.stats.chunks += 1;
    void this.device.put(devicePath, bytes);
    return bytes;
  }

  private async fetchChunk(file: string, range?: [number, number]): Promise<Response> {
    if (Date.now() > this.delivery.expiresAt - 30_000) await this.refreshDelivery();
    return fetchFile(this.delivery, file, range);
  }

  /**
   * Fetch ONE slice's full frame with a byte-range request, ahead of its
   * chunk — used for the opening slice so full quality does not wait for the
   * seven slices around it. No-op when it is already here or the bundle has
   * no ranges. Emits a `full` event like a chunk would.
   */
  async prefetchFrame(slice: number): Promise<void> {
    if (this.full.has(slice) || this.disposed) return;
    const frame = frameRange(this.index, slice);
    if (!frame) return;
    let bytes = await takeStash(`${this.stashKey(frame.file)}#${slice}`);
    if (!bytes) {
      // The whole chunk may already be on the device or on its way.
      if (this.inflight.has(`full:${chunkOrdinalFor(this.index.frames.chunks, slice)}`)) return;
      if (await this.device.get(`${this.index.version}/${frame.file}`)) return;
      let res = await this.fetchChunk(frame.file, frame.range);
      if ((res.status === 403 || res.status === 401) && (await this.refreshDelivery())) {
        res = await this.fetchChunk(frame.file, frame.range);
      }
      if (!res.ok) return;
      bytes = await rangeBody(res, frame.range);
      this.stats.networkBytes += bytes.byteLength;
    }
    if (this.disposed || this.full.has(slice) || bytes.byteLength !== frame.range[1]) return;
    const copy = bytes.slice();
    this.full.set(slice, { bytes: copy, transferSyntaxUID: frame.ts });
    this.fullBytes += copy.byteLength;
    for (const listener of this.listeners) {
      try {
        listener("full", [slice]);
      } catch {
        /* a listener must not break delivery */
      }
    }
  }

  /** New signature for the same version. False when the bundle went away. */
  private refreshDelivery(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = fetchSeriesManifest(this.index.studyInstanceUID, this.index.seriesInstanceUID, undefined, {
        fresh: true,
      })
        .then((fresh) => {
          if (!fresh || fresh.index.version !== this.index.version) return false;
          this.delivery = fresh.delivery;
          return true;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }
}

/** Decode a grey JPEG preview to its 8-bit samples (red channel). */
export async function decodePreviewGrey(preview: PreviewFrame): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([preview.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
  try {
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(preview.w, preview.h)
        : Object.assign(document.createElement("canvas"), { width: preview.w, height: preview.h });
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error("No 2D canvas for preview decode");
    ctx.drawImage(bitmap, 0, 0, preview.w, preview.h);
    const rgba = ctx.getImageData(0, 0, preview.w, preview.h).data;
    const grey = new Uint8Array(preview.w * preview.h);
    for (let i = 0, j = 0; i < grey.length; i++, j += 4) grey[i] = rgba[j];
    return grey;
  } finally {
    bitmap.close();
  }
}
