// One DICOM file's identity + geometry from its header bytes. Pure: no DOM,
// no Cornerstone, no dynamic imports — so it runs unchanged on the main
// thread, in the header-parsing Web Worker (localHeaderWorker.ts), and in
// node tests. The parser itself (`dicom-parser`) is injected.

import { hasDicomMagic, type LocalInstanceHeader } from "./localStudy";

/**
 * Header bytes read per file. Enough for the identity + geometry tags on every
 * study we have seen, including ones with long private blocks before them.
 * The parse stops at PixelData regardless.
 */
export const HEADER_BYTES = 256 * 1024;

/**
 * First read per file. A CT/MR header is 1–4 KB, so 64 KB clears almost every
 * file in one read; only files whose header runs past it (long private blocks,
 * embedded overlays/ICC profiles before PixelData) pay a second, larger read.
 * Reading 256 KB of every 512 KB CT slice up front would double the disk I/O
 * of a folder open for nothing.
 */
export const FIRST_HEADER_BYTES = 64 * 1024;

export const TAG = {
  studyInstanceUID: "x0020000d",
  seriesInstanceUID: "x0020000e",
  sopInstanceUID: "x00080018",
  instanceNumber: "x00200013",
  imagePositionPatient: "x00200032",
  imageOrientationPatient: "x00200037",
  modality: "x00080060",
  seriesNumber: "x00200011",
  seriesDescription: "x0008103e",
  studyDescription: "x00081030",
  studyDate: "x00080020",
  numberOfFrames: "x00280008",
  rows: "x00280010",
  columns: "x00280011",
  transferSyntaxUID: "x00020010",
  samplesPerPixel: "x00280002",
  bitsAllocated: "x00280100",
  pixelData: "x7fe00010",
} as const;

export interface ParsedDataSet {
  string(tag: string): string | undefined;
  intString(tag: string): number | undefined;
  uint16(tag: string): number | undefined;
}

/** The one `dicom-parser` entry point this module needs. */
export interface DicomHeaderParser {
  parseDicom(bytes: Uint8Array, options?: { untilTag?: string }): ParsedDataSet;
}

function decimalArray(dataSet: ParsedDataSet, tag: string): number[] | undefined {
  const raw = dataSet.string(tag);
  if (!raw) return undefined;
  const values = raw
    .split("\\")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : undefined;
}

/**
 * One file's identity + geometry, or null when it is not readable DICOM.
 * The parser is injected so this is testable without the browser bundle.
 */
export function parseLocalHeader(
  parser: DicomHeaderParser,
  fileName: string,
  sizeBytes: number,
  bytes: Uint8Array
): LocalInstanceHeader | null {
  if (!hasDicomMagic(bytes)) return null;
  let dataSet: ParsedDataSet;
  try {
    dataSet = parser.parseDicom(bytes, { untilTag: TAG.pixelData });
  } catch {
    // A truncated header read is expected — we only fetched the first chunk —
    // and dicom-parser throws on some of those. Such a file is unusable here.
    return null;
  }
  const text = (tag: string) => dataSet.string(tag)?.trim() || undefined;
  const int = (tag: string) => {
    const value = dataSet.intString(tag);
    return value != null && Number.isFinite(value) ? value : undefined;
  };
  const u16 = (tag: string) => {
    const value = dataSet.uint16(tag);
    return value != null && Number.isFinite(value) ? value : undefined;
  };

  return {
    fileName,
    sizeBytes,
    studyInstanceUID: text(TAG.studyInstanceUID),
    seriesInstanceUID: text(TAG.seriesInstanceUID),
    sopInstanceUID: text(TAG.sopInstanceUID),
    instanceNumber: int(TAG.instanceNumber),
    imagePositionPatient: decimalArray(dataSet, TAG.imagePositionPatient),
    imageOrientationPatient: decimalArray(dataSet, TAG.imageOrientationPatient),
    modality: text(TAG.modality),
    seriesNumber: int(TAG.seriesNumber),
    seriesDescription: text(TAG.seriesDescription),
    studyDescription: text(TAG.studyDescription),
    studyDate: text(TAG.studyDate),
    numberOfFrames: int(TAG.numberOfFrames),
    rows: u16(TAG.rows),
    columns: u16(TAG.columns),
    transferSyntaxUID: text(TAG.transferSyntaxUID),
    samplesPerPixel: u16(TAG.samplesPerPixel),
    bitsAllocated: u16(TAG.bitsAllocated),
  };
}


/**
 * Parse with the smallest read that works: FIRST_HEADER_BYTES, then
 * HEADER_BYTES only when the first read was too short for the header.
 * `read(end)` returns the first `end` bytes of the file.
 */
export async function parseLocalHeaderProgressive(
  parser: DicomHeaderParser,
  fileName: string,
  sizeBytes: number,
  read: (end: number) => Promise<Uint8Array>
): Promise<LocalInstanceHeader | null> {
  const first = await read(Math.min(sizeBytes, FIRST_HEADER_BYTES));
  // No magic: not Part 10 DICOM, and a larger read will not change that.
  if (!hasDicomMagic(first)) return null;
  const header = parseLocalHeader(parser, fileName, sizeBytes, first);
  if (header || sizeBytes <= FIRST_HEADER_BYTES) return header;
  const more = await read(Math.min(sizeBytes, HEADER_BYTES));
  return parseLocalHeader(parser, fileName, sizeBytes, more);
}
