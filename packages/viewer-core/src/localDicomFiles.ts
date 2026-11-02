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
} from "./localStudy";

export {
  HEADER_BYTES,
  FIRST_HEADER_BYTES,
  TAG,
  parseLocalHeader,
  parseLocalHeaderProgressive,
  type DicomHeaderParser,
  type ParsedDataSet,
} from "./localHeader";
import { HEADER_BYTES, parseLocalHeader, type DicomHeaderParser } from "./localHeader";

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
    studies: groupLocalStudies(headers),
    imageIdsByFile,
    skipped,
    dicomDirCount,
    warnings,
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
