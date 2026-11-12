// Read a ZIP of DICOM in the browser, without a ZIP library and without
// copying the archive.
//
// Studies are mailed and downloaded as .zip far more often than as folders
// (PACS "export to ZIP", Google Drive downloads, email attachments). The free
// viewer opens them in place:
//
//   • Only the central directory is read up front (one small read at the end
//     of the file), so a 2 GB archive lists its entries in milliseconds.
//   • STORED entries — what most PACS exports write, because DICOM pixel data
//     barely compresses — become `Blob.slice()` views of the archive: no copy,
//     no inflate, the browser streams them off disk on demand.
//   • DEFLATED entries inflate through the native `DecompressionStream`
//     ("deflate-raw"; Chrome 80+, Safari 16.4+, Firefox 113+), streamed in
//     chunks, so a large entry never blocks the main thread.
//   • ZIP64 (archives or entries past 4 GB / 65 535 entries) is supported.
//
// The directory parsing is pure over a `read(start, end)` callback so it is
// unit-tested in node (lib/zipArchive.test.ts) against archives built in the
// test; the `Blob`/`DecompressionStream` adapter is the thin part at the end.

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** EOCD record (22) + the longest possible archive comment (65 535). */
const MAX_EOCD_SEARCH = 22 + 0xffff;

export const ZIP_METHOD_STORED = 0;
export const ZIP_METHOD_DEFLATED = 8;

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the entry's LOCAL header. The data starts after it. */
  localHeaderOffset: number;
  encrypted: boolean;
}

export type ZipRead = (start: number, end: number) => Promise<Uint8Array>;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv: DataView, at: number): number {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  const value = hi * 0x1_0000_0000 + lo;
  if (!Number.isSafeInteger(value)) throw new ZipFormatError("ZIP64 offset is out of range");
  return value;
}

/** Does this file start like a ZIP (local header or empty-archive EOCD)? */
export function hasZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const sig = view(bytes).getUint32(0, true);
  return sig === SIG_LOCAL || sig === SIG_EOCD;
}

/** `.zip` by name. Content is checked again with `hasZipMagic`. */
export function looksLikeZipName(fileName: string): boolean {
  return /\.zip$/i.test(fileName);
}

/** Entries that are never study content: folders and macOS resource forks. */
export function isZipNoise(name: string): boolean {
  if (name.endsWith("/")) return true;
  return name.startsWith("__MACOSX/") || name.includes("/__MACOSX/");
}

const utf8 = new TextDecoder("utf-8");

/**
 * List a ZIP's entries from its central directory.
 * `size` is the archive length; `read` returns bytes [start, end).
 */
export async function readZipDirectory(read: ZipRead, size: number): Promise<ZipEntry[]> {
  if (size < 22) throw new ZipFormatError("Not a ZIP archive (too short)");
  const tailStart = Math.max(0, size - MAX_EOCD_SEARCH - 20);
  const tail = await read(tailStart, size);
  const tdv = view(tail);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tdv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("Not a ZIP archive (no end-of-directory record)");

  let entryCount = tdv.getUint16(eocd + 10, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let cdOffset = tdv.getUint32(eocd + 16, true);

  const needs64 = entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  const locatorAt = eocd - 20;
  if (locatorAt >= 0 && tdv.getUint32(locatorAt, true) === SIG_ZIP64_LOCATOR) {
    const z64Offset = u64(tdv, locatorAt + 8);
    const z64 = await read(z64Offset, Math.min(size, z64Offset + 56));
    const zdv = view(z64);
    if (z64.length < 56 || zdv.getUint32(0, true) !== SIG_ZIP64_EOCD) {
      throw new ZipFormatError("Corrupt ZIP64 directory");
    }
    entryCount = u64(zdv, 32);
    cdSize = u64(zdv, 40);
    cdOffset = u64(zdv, 48);
  } else if (needs64) {
    throw new ZipFormatError("Corrupt ZIP64 directory (no locator)");
  }

  if (cdOffset + cdSize > size) throw new ZipFormatError("Truncated ZIP archive");
  const cd = await read(cdOffset, cdOffset + cdSize);
  const dv = view(cd);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < entryCount; n += 1) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipFormatError("Corrupt ZIP central directory");
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localHeaderOffset = dv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    // Bit 11 = UTF-8. Legacy CP437 names are ASCII in practice for DICOM media
    // (IM000001, DICOM/ST0/SE1); decoding them as UTF-8 is lossless there.
    const name = utf8.decode(nameBytes).replace(/\\/g, "/");

    // ZIP64 extended information: present fields replace 0xFFFFFFFF ones, in order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = dv.getUint16(e, true);
      const len = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = u64(dv, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(dv, q);
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(dv, q);
      }
      e += 4 + len;
    }

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 0x1) !== 0,
    });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** Offset of an entry's data: past its local header, whose lengths can differ from the central one. */
export async function zipEntryDataOffset(read: ZipRead, entry: ZipEntry): Promise<number> {
  const local = await read(entry.localHeaderOffset, entry.localHeaderOffset + 30);
  const dv = view(local);
  if (local.length < 30 || dv.getUint32(0, true) !== SIG_LOCAL) {
    throw new ZipFormatError(`Corrupt ZIP entry header: ${entry.name}`);
  }
  return entry.localHeaderOffset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
}

// ---------------------------------------------------------------------------
// Browser adapter
// ---------------------------------------------------------------------------

export interface ZipFileEntry {
  /** `archive.zip/inner/path` — what the series rail and grouping see. */
  path: string;
  size: number;
  /** Resolves the entry as a `File`. STORED: a zero-copy slice. DEFLATED: inflated. */
  open: () => Promise<File>;
}

export interface ZipListing {
  entries: ZipFileEntry[];
  /** Entries we cannot open (encrypted, or a method other than stored/deflate). */
  unsupported: number;
}

function blobRead(blob: Blob): ZipRead {
  return async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Whether this browser can inflate DEFLATE entries natively. */
export function canInflateZip(): boolean {
  if (typeof DecompressionStream === "undefined") return false;
  try {
    new DecompressionStream("deflate-raw" as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

/**
 * List a ZIP `File`'s entries as lazily-opened `File`s. Nothing is read beyond
 * the central directory until an entry's `open()` is called.
 */
export async function listZipFile(archive: Blob, archiveName: string): Promise<ZipListing> {
  const read = blobRead(archive);
  const raw = await readZipDirectory(read, archive.size);
  const inflate = canInflateZip();
  const entries: ZipFileEntry[] = [];
  let unsupported = 0;
  const prefix = archiveName.replace(/\.zip$/i, "");
  for (const entry of raw) {
    if (isZipNoise(entry.name)) continue;
    const supported =
      !entry.encrypted &&
      (entry.method === ZIP_METHOD_STORED || (entry.method === ZIP_METHOD_DEFLATED && inflate));
    if (!supported) {
      unsupported += 1;
      continue;
    }
    const baseName = entry.name.split("/").pop() || entry.name;
    entries.push({
      path: `${prefix}/${entry.name}`,
      size: entry.uncompressedSize,
      open: async () => {
        const start = await zipEntryDataOffset(read, entry);
        const slice = archive.slice(start, start + entry.compressedSize);
        const body =
          entry.method === ZIP_METHOD_STORED
            ? slice
            : await new Response(
                slice.stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat))
              ).blob();
        return new File([body], baseName, { type: "application/dicom" });
      },
    });
  }
  return { entries, unsupported };
}
