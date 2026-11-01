"use client";

// Browser adapter for opening DICOM off the local disk. Nothing is uploaded.
//
// Reads each dropped/selected file's header with `dicom-parser` (already a
// dependency), hands the bytes to the Cornerstone wadouri `fileManager` so the
// viewer can render them from memory, and lets `lib/localStudy.ts` do the
// grouping and ordering. The same split works unchanged inside a Tauri or
// Electron shell — only the *source of the bytes* differs there (a real path
// instead of a `File`), which is why the parsing and grouping live apart from
// the file picker. See `docs/DESKTOP_PLAN.md`.
//
// Cost control, because a study CD is 700 MB and a chest CTA is 2 GB:
//   • Only the first HEADER_BYTES of each file are read to triage and parse
//     identity. `dicom-parser`'s `untilTag` stops at the pixel data, so we
//     never hold a whole series in memory just to list it.
//   • Pixel bytes are read lazily, per instance, when the viewer asks for a
//     frame — `fileManager.add` keeps a reference to the `File`, and the
//     browser streams from disk on demand.
//   • Obvious non-DICOM files are skipped without being opened at all.
//   • `dicom-parser` and the Cornerstone loader are imported on first use, not
//     at module scope. The landing state of /viewer/local is a dropzone; it
//     must not ship a megabyte of decoder before the user has chosen a folder.

import {
  groupLocalStudies,
  hasDicomMagic,
  imageIdsForInstance,
  instanceImageCount,
  isDicomDir,
  isObviouslyNotDicom,
  type LocalInstanceHeader,
  type LocalSeries,
  type LocalStudy,
  withKeyImageSeries,
} from "./localStudy";
import { documentFromDataSet, isStructuredDocumentClass, type DicomDocument, type SrDataSet } from "./srDocument";

/**
 * Header bytes read per file. Enough for the identity + geometry tags on every
 * study we have seen, including ones with long private blocks before them.
 * The parse stops at PixelData regardless.
 */
export const HEADER_BYTES = 256 * 1024;

const TAG = {
  studyInstanceUID: "x0020000d",
  seriesInstanceUID: "x0020000e",
  sopInstanceUID: "x00080018",
  sopClassUID: "x00080016",
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

let parserPromise: Promise<DicomHeaderParser> | null = null;
let fileManagerPromise: Promise<{ add(file: File): string }> | null = null;

/** `dicom-parser`, loaded on first use. */
export function loadHeaderParser(): Promise<DicomHeaderParser> {
  parserPromise ??= import("dicom-parser").then(
    (module) => (module.default ?? module) as unknown as DicomHeaderParser
  );
  return parserPromise;
}

/** Cornerstone's wadouri file manager, loaded on first use. */
function loadFileManager(): Promise<{ add(file: File): string }> {
  fileManagerPromise ??= import("@cornerstonejs/dicom-image-loader").then(
    (module) =>
      (module.default ?? module).wadouri.fileManager as unknown as { add(file: File): string }
  );
  return fileManagerPromise;
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
    sopClassUID: text(TAG.sopClassUID),
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
  };
}

export interface LocalOpenProgress {
  /** Files inspected so far. */
  read: number;
  /** Files that turned out to be DICOM images. */
  accepted: number;
  total: number;
}

export interface LocalOpenResult {
  studies: LocalStudy[];
  /** `dicomfile:` imageIds keyed by `fileName`, in the viewer's stack order. */
  imageIdsByFile: Map<string, string[]>;
  skipped: number;
  dicomDirCount: number;
  /** Non-fatal problems worth telling the user about. */
  warnings: string[];
  /** Structured Reports and key-image notes found among the files. */
  documents: DicomDocument[];
}

/**
 * Read a set of local files into studies the viewer can open.
 *
 * `onProgress` fires as files are triaged so a 2000-file folder shows movement
 * instead of a frozen dropzone. Nothing leaves the machine.
 */
export async function openLocalFiles(
  files: readonly File[],
  options?: {
    onProgress?: (progress: LocalOpenProgress) => void;
    signal?: AbortSignal;
  }
): Promise<LocalOpenResult> {
  const [parser, fileManager] = await Promise.all([loadHeaderParser(), loadFileManager()]);
  const headers: LocalInstanceHeader[] = [];
  const imageIdsByFile = new Map<string, string[]>();
  const warnings: string[] = [];
  const documents: DicomDocument[] = [];
  let skipped = 0;
  let dicomDirCount = 0;
  let read = 0;

  for (const file of files) {
    if (options?.signal?.aborted) break;
    read += 1;
    const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

    if (isDicomDir(name)) {
      dicomDirCount += 1;
      // The index is not needed: we have every file in hand already, and the
      // image headers are the authority on grouping. Reading DICOMDIR would
      // only matter for media we can only partially access.
      continue;
    }
    if (isObviouslyNotDicom(name)) {
      skipped += 1;
      continue;
    }

    let header: LocalInstanceHeader | null = null;
    try {
      const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
      header = parseLocalHeader(parser, name, file.size, head);
    } catch (error) {
      warnings.push(`${name}: could not be read (${String(error)})`);
    }
    if (!header) {
      skipped += 1;
      options?.onProgress?.({ read, accepted: headers.length, total: files.length });
      continue;
    }
    if (isStructuredDocumentClass(header.sopClassUID)) {
      // A report or key-image note: no pixels. Read it whole (they are small)
      // for the content tree instead of adding it as an image.
      try {
        const doc = documentFromDataSet(
          parser.parseDicom(new Uint8Array(await file.arrayBuffer())) as unknown as SrDataSet,
          name
        );
        if (doc) documents.push(doc);
      } catch (error) {
        warnings.push(`${name}: this report could not be read (${String(error)})`);
      }
      continue;
    }

    const baseImageId = fileManager.add(file);
    imageIdsByFile.set(name, imageIdsForInstance(baseImageId, instanceImageCount(header)));
    headers.push(header);
    options?.onProgress?.({ read, accepted: headers.length, total: files.length });
  }

  if (headers.length === 0 && dicomDirCount > 0) {
    warnings.push(
      "This folder has a DICOMDIR index but no readable images beside it — open the folder that contains the image files."
    );
  }

  return {
    studies: withKeyImageSeries(groupLocalStudies(headers), documents),
    imageIdsByFile,
    skipped,
    dicomDirCount,
    warnings,
    documents,
  };
}

/** Ordered imageIds for one series — the stack the viewer scrolls. */
export function seriesImageIds(
  series: LocalSeries,
  imageIdsByFile: Map<string, string[]>
): string[] {
  const out: string[] = [];
  for (const instance of series.instances) {
    const ids = imageIdsByFile.get(instance.fileName);
    if (ids) out.push(...ids);
  }
  return out;
}
