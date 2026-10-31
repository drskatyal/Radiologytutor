// ============================================================================
// lib/dicomCdn/pack.ts  (server only)
//
// Convert ONE series, once, into the bundle layout in lib/dicomCdn/format.ts.
//
//   1. Read the archive's series metadata document (its array order is the
//      viewer's stack order — never re-sorted here).
//   2. For each instance, read frame 1 as Explicit VR Little Endian (the
//      archive transcodes; Healthcare and Orthanc both honour the
//      `transfer-syntax` Accept parameter). If the archive will only return the
//      stored encoding, a compressed frame is kept as-is ("lossless fallback":
//      the original bytes, decoded by Cornerstone as today) and gets no preview.
//   3. Grey frames → HTJ2K lossless RPCL. If the encoder throws, the raw LE
//      frame is stored instead — never a lossy substitute.
//   4. Grey frames → 8-bit JPEG preview at the instance's default window.
//   5. Pack into FRB1 chunks, upload, write meta.gz, write index.json LAST,
//      then delete older versions.
//
// De-identification is untouched: the input is what is already in the
// archive, which only ever received bytes that passed lib/deid.ts at upload.
// Anything that cannot be converted cleanly aborts the build; the viewer then
// keeps using DICOMweb for that series. There are no partial bundles.
// ============================================================================

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { parseDicom, readEncapsulatedPixelDataFromFragments } from "dicom-parser";
import { dicomWebRoot } from "../imagingBackend";
import { imagingAuthHeader } from "../orthanc";
import { encodeGreyJpeg, encodeHtj2kLossless } from "./encode";
import {
  BUNDLE_SCHEMA,
  CHUNK_CACHE_CONTROL,
  FULL_CHUNK_MAX_FRAMES,
  FULL_CHUNK_TARGET_BYTES,
  PREVIEW_CHUNK_FRAMES,
  PREVIEW_MAX_DIM,
  TS_EXPLICIT_LE,
  TS_HTJ2K_LOSSLESS_RPCL,
  TS_IMPLICIT_LE,
  chunkFileName,
  indexKey,
  packContainer,
  seriesKeyPrefix,
  versionPrefix,
  type BundleEntry,
  type BundleHeader,
  type ChunkRef,
  type SeriesBundleIndex,
} from "./format";
import type { BundleStore } from "./store";
import {
  describePixels,
  rawPixelView,
  renderPreview8,
  storedWindow,
  type DicomWindow,
} from "./windowing";

const SOP_TAG = "00080018";
const PIXEL_DATA_TAG = "7FE00010";

const INDEX_CACHE_CONTROL = "private, no-store";

export interface InstancePixels {
  transferSyntaxUID: string;
  /** Frame 1: raw little-endian samples, or one encapsulated codestream. */
  bytes: Uint8Array;
}

/** What the packer needs from the archive. A seam so tests run without one. */
export interface ArchiveReader {
  seriesMetadata(study: string, series: string): Promise<unknown[]>;
  instancePixels(study: string, series: string, sop: string): Promise<InstancePixels>;
}

export class NotConvertibleError extends Error {}

const UNCOMPRESSED = new Set([TS_EXPLICIT_LE, TS_IMPLICIT_LE]);

// --- archive (DICOMweb) -------------------------------------------------------

/** Pull frame 1 out of a Part-10 file. */
export function framePixelsFromPart10(bytes: Uint8Array): InstancePixels {
  const ds = parseDicom(bytes);
  const ts = ds.string("x00020010")?.trim() || TS_IMPLICIT_LE;
  const el = ds.elements.x7fe00010;
  if (!el) throw new NotConvertibleError("Instance has no pixel data");
  if (el.encapsulatedPixelData) {
    const fragments = el.fragments ?? [];
    if (fragments.length === 0) throw new NotConvertibleError("Encapsulated pixel data has no fragments");
    // Single-frame instances only (see buildSeriesBundle), so every fragment is frame 1.
    const frame = readEncapsulatedPixelDataFromFragments(ds, el, 0, fragments.length);
    return { transferSyntaxUID: ts, bytes: new Uint8Array(frame) };
  }
  return {
    transferSyntaxUID: ts,
    bytes: new Uint8Array(ds.byteArray.buffer, ds.byteArray.byteOffset + el.dataOffset, el.length),
  };
}

export function dicomwebArchiveReader(): ArchiveReader {
  const root = () => dicomWebRoot();
  return {
    async seriesMetadata(study, series) {
      const res = await fetch(
        `${root()}/studies/${encodeURIComponent(study)}/series/${encodeURIComponent(series)}/metadata`,
        {
          headers: { Authorization: await imagingAuthHeader(), Accept: "application/dicom+json" },
          cache: "no-store",
        }
      );
      if (!res.ok) throw new Error(`Series metadata -> ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error("Series metadata was not an array");
      return body;
    },
    async instancePixels(study, series, sop) {
      const url =
        `${root()}/studies/${encodeURIComponent(study)}` +
        `/series/${encodeURIComponent(series)}/instances/${encodeURIComponent(sop)}`;
      // Ask the archive to transcode to raw LE; fall back to the stored syntax.
      for (const ts of [TS_EXPLICIT_LE, "*"]) {
        const res = await fetch(url, {
          headers: {
            Authorization: await imagingAuthHeader(),
            Accept: `application/dicom; transfer-syntax=${ts}`,
          },
          cache: "no-store",
        });
        if (res.ok) return framePixelsFromPart10(new Uint8Array(await res.arrayBuffer()));
        if (res.status !== 406 && res.status !== 400 && res.status !== 415) {
          throw new Error(`Instance ${sop} -> ${res.status}`);
        }
      }
      throw new NotConvertibleError(`Archive would not return instance ${sop}`);
    },
  };
}

// --- packing -------------------------------------------------------------------

/** DICOM JSON without bulk data — what Cornerstone's wadors metadata provider reads. */
export function stripBulkData(dataset: unknown): unknown {
  if (!dataset || typeof dataset !== "object") return dataset;
  const out: Record<string, unknown> = {};
  for (const [tag, value] of Object.entries(dataset as Record<string, unknown>)) {
    if (tag.toUpperCase() === PIXEL_DATA_TAG) continue;
    if (value && typeof value === "object" && ("BulkDataURI" in value || "InlineBinary" in value)) continue;
    out[tag] = value;
  }
  return out;
}

function sopOf(dataset: unknown): string | undefined {
  const raw = (dataset as Record<string, { Value?: unknown[] }> | null)?.[SOP_TAG]?.Value?.[0];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function frameWindow(meta: unknown, pixels: ArrayLike<number>, slope: number, intercept: number): DicomWindow {
  const stored = storedWindow(meta);
  if (stored) return stored;
  // No stored window: Cornerstone falls back to the frame's min/max, so the
  // preview does too — otherwise the swap to full quality would shift tone.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { center: 0, width: 1 };
  const lo = min * slope + intercept;
  const hi = max * slope + intercept;
  const width = Math.max(1, Math.abs(hi - lo));
  return { center: Math.min(lo, hi) + width / 2, width };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface ConvertedFrame {
  index: number;
  sop: string;
  meta: unknown;
  full: Uint8Array;
  fullTs: string;
  preview?: { jpeg: Uint8Array; w: number; h: number; lo: number; hi: number };
  sourceBytes: number;
}

async function convertFrame(
  archive: ArchiveReader,
  study: string,
  series: string,
  index: number,
  meta: unknown
): Promise<ConvertedFrame> {
  const sop = sopOf(meta)!;
  const desc = describePixels(meta);
  if (!desc) throw new NotConvertibleError(`Instance ${sop} has no pixel module`);
  const src = await archive.instancePixels(study, series, sop);
  const base = { index, sop, meta: stripBulkData(meta), sourceBytes: src.bytes.byteLength };

  const grey = desc.samplesPerPixel === 1 && (desc.bitsAllocated === 8 || desc.bitsAllocated === 16);
  if (!UNCOMPRESSED.has(src.transferSyntaxUID) || !grey) {
    // Lossless fallback: the frame exactly as the archive returned it.
    return { ...base, full: src.bytes, fullTs: src.transferSyntaxUID };
  }

  const frameBytes = desc.rows * desc.columns * (desc.bitsAllocated / 8);
  const raw = src.bytes.subarray(0, frameBytes);
  let full: Uint8Array;
  let fullTs = TS_HTJ2K_LOSSLESS_RPCL;
  try {
    full = await encodeHtj2kLossless({
      bytes: raw,
      rows: desc.rows,
      columns: desc.columns,
      bitsAllocated: desc.bitsAllocated as 8 | 16,
      signed: desc.pixelRepresentation === 1,
    });
  } catch {
    full = raw;
    fullTs = TS_EXPLICIT_LE;
  }

  let preview: ConvertedFrame["preview"];
  try {
    const pixels = rawPixelView(raw, desc);
    const win = frameWindow(meta, pixels, desc.rescaleSlope, desc.rescaleIntercept);
    const p = renderPreview8(pixels, desc.rows, desc.columns, desc.rescaleSlope, desc.rescaleIntercept, win, PREVIEW_MAX_DIM);
    preview = { jpeg: await encodeGreyJpeg(p.data, p.w, p.h), w: p.w, h: p.h, lo: p.lo, hi: p.hi };
  } catch {
    preview = undefined;
  }
  return { ...base, full, fullTs, preview };
}

function gzJson(value: unknown): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(value), "utf8"), { level: 6 }));
}

export interface BuildStats {
  frames: number;
  sourceBytes: number;
  fullBytes: number;
  previewBytes: number;
  metaBytes: number;
  chunks: number;
  ms: number;
}

export interface BuildResult {
  index: SeriesBundleIndex;
  stats: BuildStats;
}

export interface BuildOptions {
  archive?: ArchiveReader;
  /** Instances fetched + encoded at once. */
  concurrency?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export async function buildSeriesBundle(
  store: BundleStore,
  study: string,
  series: string,
  opts: BuildOptions = {}
): Promise<BuildResult> {
  const started = Date.now();
  const archive = opts.archive ?? dicomwebArchiveReader();
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const createdAt = (opts.now?.() ?? new Date()).toISOString();

  const metadata = await archive.seriesMetadata(study, series);
  if (metadata.length === 0) throw new NotConvertibleError("Series has no instances");
  const sops: string[] = [];
  for (const meta of metadata) {
    const sop = sopOf(meta);
    if (!sop) throw new NotConvertibleError("An instance has no SOP Instance UID");
    const desc = describePixels(meta);
    // The viewer addresses `/frames/1` only; a multi-frame series would lose frames.
    if (desc && desc.numberOfFrames > 1) throw new NotConvertibleError("Multi-frame instances are served by DICOMweb");
    sops.push(sop);
  }

  const version = createHash("sha1")
    .update(`${BUNDLE_SCHEMA}|${study}|${series}|${createdAt}|${sops.join(",")}`)
    .digest("hex")
    .slice(0, 16);
  const dir = versionPrefix(study, series, version);
  const put = (file: string, body: Uint8Array) =>
    store.put(`${dir}/${file}`, body, { contentType: "application/octet-stream", cacheControl: CHUNK_CACHE_CONTROL });

  const previewChunks: ChunkRef[] = [];
  const fullChunks: ChunkRef[] = [];
  let pending: ConvertedFrame[] = [];
  let pendingBytes = 0;
  let fallbackFrames = 0;
  let previewMissing = 0;
  const stats: BuildStats = { frames: 0, sourceBytes: 0, fullBytes: 0, previewBytes: 0, metaBytes: 0, chunks: 0, ms: 0 };
  let rows: number | undefined;
  let columns: number | undefined;
  let window: DicomWindow | undefined;

  const flushFull = async () => {
    if (pending.length === 0) return;
    const entries: BundleEntry[] = [];
    const payload: Uint8Array[] = [];
    let off = 0;
    for (const f of pending) {
      entries.push({
        i: f.index,
        sop: f.sop,
        off,
        len: f.full.byteLength,
        ...(f.fullTs !== TS_HTJ2K_LOSSLESS_RPCL ? { ts: f.fullTs } : {}),
      });
      payload.push(f.full);
      off += f.full.byteLength;
    }
    const header: BundleHeader = { kind: "full", entries };
    const gzHeader = gzJson(header);
    const body = packContainer(gzHeader, payload);
    const file = chunkFileName("full", fullChunks.length);
    await put(file, body);
    const payloadAt = 8 + gzHeader.byteLength;
    fullChunks.push({
      file,
      start: pending[0].index,
      count: pending.length,
      bytes: body.byteLength,
      ranges: entries.map((e) => (e.ts ? [payloadAt + e.off, e.len, e.ts] : [payloadAt + e.off, e.len])),
    });
    stats.fullBytes += body.byteLength;
    stats.chunks += 1;
    pending = [];
    pendingBytes = 0;
  };

  for (let start = 0; start < metadata.length; start += PREVIEW_CHUNK_FRAMES) {
    const window_ = metadata.slice(start, start + PREVIEW_CHUNK_FRAMES);
    const frames = await mapLimit(window_, concurrency, (meta, k) =>
      convertFrame(archive, study, series, start + k, meta)
    );

    // Preview chunk for this window (metadata always present, JPEG when available).
    const entries: BundleEntry[] = [];
    const payload: Uint8Array[] = [];
    let off = 0;
    for (const f of frames) {
      stats.frames += 1;
      stats.sourceBytes += f.sourceBytes;
      if (f.fullTs !== TS_HTJ2K_LOSSLESS_RPCL) fallbackFrames += 1;
      if (!f.preview) {
        previewMissing += 1;
        entries.push({ i: f.index, sop: f.sop, off, len: 0 });
        continue;
      }
      entries.push({ i: f.index, sop: f.sop, off, len: f.preview.jpeg.byteLength, w: f.preview.w, h: f.preview.h, lo: f.preview.lo, hi: f.preview.hi });
      payload.push(f.preview.jpeg);
      off += f.preview.jpeg.byteLength;
      if (rows == null) {
        const d = describePixels(f.meta);
        rows = d?.rows;
        columns = d?.columns;
        window = { center: (f.preview.lo + f.preview.hi) / 2, width: f.preview.hi - f.preview.lo };
      }
    }
    const header: BundleHeader = { kind: "preview", entries, meta: frames.map((f) => f.meta) };
    const body = packContainer(gzJson(header), payload);
    const file = chunkFileName("preview", previewChunks.length);
    await put(file, body);
    previewChunks.push({ file, start, count: frames.length, bytes: body.byteLength });
    stats.previewBytes += body.byteLength;
    stats.chunks += 1;

    for (const f of frames) {
      if (pending.length > 0 && (pendingBytes + f.full.byteLength > FULL_CHUNK_TARGET_BYTES || pending.length >= FULL_CHUNK_MAX_FRAMES)) {
        await flushFull();
      }
      pending.push(f);
      pendingBytes += f.full.byteLength;
    }
    opts.log?.(`  ${Math.min(metadata.length, start + PREVIEW_CHUNK_FRAMES)}/${metadata.length} frames`);
  }
  await flushFull();

  const metaGz = gzJson(metadata.map(stripBulkData));
  await put("meta.gz", metaGz);
  stats.metaBytes = metaGz.byteLength;

  const index: SeriesBundleIndex = {
    schema: BUNDLE_SCHEMA,
    version,
    studyInstanceUID: study,
    seriesInstanceUID: series,
    createdAt,
    sops,
    ...(rows ? { rows } : {}),
    ...(columns ? { columns } : {}),
    ...(window ? { window } : {}),
    meta: { file: "meta.gz", bytes: metaGz.byteLength },
    previews: { format: "jpeg", maxDim: PREVIEW_MAX_DIM, chunks: previewChunks },
    frames: { transferSyntaxUID: TS_HTJ2K_LOSSLESS_RPCL, chunks: fullChunks },
    ...(fallbackFrames ? { fallbackFrames } : {}),
    ...(previewMissing ? { previewMissing } : {}),
  };
  // Index last: readers switch to the new version only once it is complete.
  await store.put(indexKey(study, series), Buffer.from(JSON.stringify(index), "utf8"), {
    contentType: "application/json",
    cacheControl: INDEX_CACHE_CONTROL,
  });

  // Retire older versions. Best effort — a leftover directory is unreachable, not unsafe.
  try {
    const keep = `${dir}/`;
    const idx = indexKey(study, series);
    for (const key of await store.list(`${seriesKeyPrefix(study, series)}/`)) {
      if (key !== idx && !key.startsWith(keep)) await store.delete(key);
    }
  } catch {
    /* sweep again on the next build */
  }

  stats.ms = Date.now() - started;
  return { index, stats };
}

/** Current index for a series, or null. */
export async function readSeriesIndex(store: BundleStore, study: string, series: string): Promise<unknown | null> {
  const bytes = await store.get(indexKey(study, series));
  if (!bytes) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
