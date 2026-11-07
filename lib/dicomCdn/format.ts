// ============================================================================
// lib/dicomCdn/format.ts  (isomorphic — server packer AND browser client)
//
// The on-bucket shape of a converted series. One series is converted ONCE
// (at upload, or by the backfill script) into:
//
//   dicom/v1/{study}/{series}/index.json            manifest, read server-side only
//   dicom/v1/{study}/{series}/{version}/meta.gz     whole-series DICOM JSON, gzip
//   dicom/v1/{study}/{series}/{version}/p0000.frb   8-bit JPEG previews, ~32/chunk
//   dicom/v1/{study}/{series}/{version}/f0000.frb   HTJ2K lossless frames, ~2 MB/chunk
//
// A chunk is a "frame bundle" (FRB1): many frames in ONE object, so the viewer
// pays one request per ~8–32 slices instead of one per slice. Versioned
// directories are immutable; index.json is written last, so a reader either
// sees the old complete version or the new complete version.
//
// Order is the archive's series-metadata array order — the same order the
// DICOMweb path stacks in — so a stored `sliceIndex` lands on the same image
// whichever path served the pixels.
//
// No Node or DOM APIs here: this file is imported by both sides and unit-tested.
// ============================================================================

/** Bump when the bundle layout changes; older bundles are then rebuilt. */
export const BUNDLE_SCHEMA = 1;

export const BUNDLE_KEY_ROOT = "dicom/v1";

/** HTJ2K Lossless Only, RPCL progression (resolution-progressive). */
export const TS_HTJ2K_LOSSLESS_RPCL = "1.2.840.10008.1.2.4.202";
/** Explicit VR Little Endian — the lossless fallback when HTJ2K encode fails. */
export const TS_EXPLICIT_LE = "1.2.840.10008.1.2.1";
export const TS_IMPLICIT_LE = "1.2.840.10008.1.2";

/** Previews per preview chunk. ~8–15 KB each → a few hundred KB per request. */
export const PREVIEW_CHUNK_FRAMES = 32;
/** Longest preview edge in pixels. Upscaled on screen until the full frame lands. */
export const PREVIEW_MAX_DIM = 384;
/** JPEG quality for previews (libjpeg-turbo 0–100). */
export const PREVIEW_JPEG_QUALITY = 72;
/**
 * Full-quality chunks close at this many bytes (or FULL_CHUNK_MAX_FRAMES).
 * Small enough that the chunk under the reader lands in a few hundred ms on a
 * 50 Mbit/s link; big enough that a 1000-slice CT is ~150 requests, not 1000.
 */
export const FULL_CHUNK_TARGET_BYTES = 1024 * 1024;
export const FULL_CHUNK_MAX_FRAMES = 8;

/**
 * Chunk objects are immutable (versioned path). `private`: no shared proxy may
 * keep them. Cloud CDN still caches them because its cache mode is
 * FORCE_CACHE_ALL and every edge request is signature-checked
 * (deploy/gcp/terraform/dicom_cdn.tf).
 */
export const CHUNK_CACHE_CONTROL = "private, max-age=31536000, immutable";

export interface ChunkRef {
  /** File name inside the version directory, e.g. `p0003.frb`. */
  file: string;
  /** First stack index in this chunk. Chunks cover contiguous index ranges. */
  start: number;
  count: number;
  bytes: number;
  /**
   * Full chunks only: byte range of each frame inside the FILE, in stack
   * order — `[offset, length]`, plus the transfer syntax when it is not the
   * series default. Lets the viewer fetch the one slice on screen with an
   * HTTP Range request before the rest of its chunk.
   */
  ranges?: Array<[number, number] | [number, number, string]>;
}

export interface SeriesBundleIndex {
  schema: number;
  /** Content version — names the immutable directory the chunks live in. */
  version: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  createdAt: string;
  /** SOP Instance UIDs in stack order. */
  sops: string[];
  rows?: number;
  columns?: number;
  /** Series default window the previews were rendered at (modality units). */
  window?: { center: number; width: number };
  meta: { file: string; bytes: number };
  previews: { format: "jpeg"; maxDim: number; chunks: ChunkRef[] };
  frames: { transferSyntaxUID: string; chunks: ChunkRef[] };
  /** Frames stored in a fallback encoding (raw or as-archived). Informational. */
  fallbackFrames?: number;
  /** Frames with no preview (colour or undecodable source). They wait for full. */
  previewMissing?: number;
}

/** One frame inside a bundle. Offsets are into the payload that follows the header. */
export interface BundleEntry {
  /** Stack index. */
  i: number;
  sop: string;
  off: number;
  len: number;
  /** Per-frame transfer syntax when it differs from the series default. */
  ts?: string;
  /** Preview geometry: pixel size and the modality-unit window the 8 bits span. */
  w?: number;
  h?: number;
  lo?: number;
  hi?: number;
}

export interface BundleHeader {
  kind: "preview" | "full";
  entries: BundleEntry[];
  /**
   * Preview chunks repeat the DICOM JSON for their own instances, so the
   * opening slice can be registered and painted before meta.gz arrives.
   */
  meta?: unknown[];
}

// --- keys -------------------------------------------------------------------

const UID_RE = /^\d+(\.\d+)+$/;
const VERSION_RE = /^[a-z0-9]{6,40}$/;
const FILE_RE = /^(?:[pf]\d{4}\.frb|meta\.gz)$/;

export function isDicomUid(value: string): boolean {
  return UID_RE.test(value) && value.length <= 64;
}

export function isBundleVersion(value: string): boolean {
  return VERSION_RE.test(value);
}

export function isBundleFile(value: string): boolean {
  return FILE_RE.test(value);
}

export function seriesKeyPrefix(study: string, series: string): string {
  return `${BUNDLE_KEY_ROOT}/${study}/${series}`;
}

export function indexKey(study: string, series: string): string {
  return `${seriesKeyPrefix(study, series)}/index.json`;
}

export function versionPrefix(study: string, series: string, version: string): string {
  return `${seriesKeyPrefix(study, series)}/${version}`;
}

export function chunkFileName(kind: "preview" | "full", ordinal: number): string {
  return `${kind === "preview" ? "p" : "f"}${String(ordinal).padStart(4, "0")}.frb`;
}

// --- container --------------------------------------------------------------

const MAGIC = [0x46, 0x52, 0x42, 0x31]; // "FRB1"

/**
 * FRB1 container:  "FRB1" | u32 LE header length | gzip(JSON header) | payload.
 * The header is gzip-compressed by the caller (Node zlib on write,
 * DecompressionStream in the browser), so this layer stays dependency-free.
 */
export function packContainer(gzHeader: Uint8Array, payload: readonly Uint8Array[]): Uint8Array {
  let payloadBytes = 0;
  for (const part of payload) payloadBytes += part.byteLength;
  const out = new Uint8Array(8 + gzHeader.byteLength + payloadBytes);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, gzHeader.byteLength, true);
  out.set(gzHeader, 8);
  let at = 8 + gzHeader.byteLength;
  for (const part of payload) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export interface UnpackedContainer {
  gzHeader: Uint8Array;
  payload: Uint8Array;
}

export function unpackContainer(bytes: Uint8Array): UnpackedContainer {
  if (bytes.byteLength < 8 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error("Not a frame bundle");
  }
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + headerLen > bytes.byteLength) throw new Error("Frame bundle header is truncated");
  return {
    gzHeader: bytes.subarray(8, 8 + headerLen),
    payload: bytes.subarray(8 + headerLen),
  };
}

/** Bytes of one entry, bounds-checked. */
export function entryBytes(payload: Uint8Array, entry: BundleEntry): Uint8Array {
  if (entry.off < 0 || entry.len < 0 || entry.off + entry.len > payload.byteLength) {
    throw new Error(`Frame ${entry.i} is outside its bundle`);
  }
  return payload.subarray(entry.off, entry.off + entry.len);
}

// --- planning ---------------------------------------------------------------

/** The chunk whose index range holds `index`, or -1. Chunks are sorted by `start`. */
export function chunkOrdinalFor(chunks: readonly ChunkRef[], index: number): number {
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chunks[mid];
    if (index < c.start) hi = mid - 1;
    else if (index >= c.start + c.count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Slice distance from `index` to the nearest frame inside `chunk`. */
export function chunkDistance(chunk: ChunkRef, index: number): number {
  if (index < chunk.start) return chunk.start - index;
  const last = chunk.start + chunk.count - 1;
  if (index > last) return index - last;
  return 0;
}

export interface PlannedFetch {
  kind: "preview" | "full";
  ordinal: number;
  /** Lower runs first. */
  score: number;
}

/**
 * Fetch order around the slice on screen:
 *   1. preview chunk under the current slice (first paint),
 *   2. full chunk under the current slice,
 *   3. then outward by distance — previews weighted so the whole stack becomes
 *      scrollable early (they are ~1/20 the bytes), full frames close behind,
 *   4. then the rest.
 * Pure: the client re-plans every time the reader moves.
 */
export function planFetchOrder(
  index: SeriesBundleIndex,
  current: number,
  done: { preview: ReadonlySet<number>; full: ReadonlySet<number> }
): PlannedFetch[] {
  const out: PlannedFetch[] = [];
  const PREVIEW_WEIGHT = 0.25;
  index.previews.chunks.forEach((chunk, ordinal) => {
    if (done.preview.has(ordinal)) return;
    const d = chunkDistance(chunk, current);
    out.push({ kind: "preview", ordinal, score: d === 0 ? -2 : d * PREVIEW_WEIGHT });
  });
  index.frames.chunks.forEach((chunk, ordinal) => {
    if (done.full.has(ordinal)) return;
    const d = chunkDistance(chunk, current);
    out.push({ kind: "full", ordinal, score: d === 0 ? -1 : d });
  });
  out.sort((a, b) => a.score - b.score || (a.kind === b.kind ? a.ordinal - b.ordinal : a.kind === "preview" ? -1 : 1));
  return out;
}

/**
 * Stack index to open on, given the same hints the DICOMweb path takes.
 * Mirrors lib/viewerLoad.resolveOpenIndex so both paths land on one slice.
 */
export function bundleOpenIndex(
  sops: readonly string[],
  hint?: { sopInstanceUID?: string; sliceIndex?: number } | null
): number {
  const count = sops.length;
  if (count <= 0) return 0;
  const sop = hint?.sopInstanceUID?.trim();
  if (sop) {
    const found = sops.indexOf(sop);
    if (found >= 0) return found;
  }
  if (hint?.sliceIndex != null && Number.isFinite(hint.sliceIndex)) {
    return Math.max(0, Math.min(count - 1, Math.round(hint.sliceIndex)));
  }
  return Math.floor(count / 2);
}

/** Sanity check of an index read from the bucket or the API. */
export function isUsableIndex(value: unknown): value is SeriesBundleIndex {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SeriesBundleIndex>;
  return (
    v.schema === BUNDLE_SCHEMA &&
    typeof v.version === "string" &&
    isBundleVersion(v.version) &&
    Array.isArray(v.sops) &&
    v.sops.length > 0 &&
    !!v.meta &&
    !!v.previews &&
    Array.isArray(v.previews.chunks) &&
    !!v.frames &&
    Array.isArray(v.frames.chunks) &&
    v.frames.chunks.length > 0
  );
}
