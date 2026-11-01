// Header-parsing Web Worker for the local (no-upload) viewer.
//
// One of a small pool (see localIngest.ts). Receives a `File` — structured
// clone of a File is a handle, not a copy — reads the first FIRST_HEADER_BYTES
// (or HEADER_BYTES when the header is longer), parses identity + geometry with
// `dicom-parser`, and posts back a small plain record. Pixel bytes never come
// through here: they are read later, per frame, by the decode workers.
//
// Never logs. A header carries patient identifiers; nothing from it may reach
// a console, a network request, or an error report.

import dicomParser from "dicom-parser";
import { parseLocalHeaderProgressive, type DicomHeaderParser } from "./localHeader";
import type { LocalInstanceHeader } from "./localStudy";

export interface HeaderJob {
  id: number;
  file: File;
  name: string;
}

export interface HeaderJobResult {
  id: number;
  header: LocalInstanceHeader | null;
  /** Read failed (unreadable file, permission revoked). No identifiers. */
  failed?: boolean;
}

const parser = dicomParser as unknown as DicomHeaderParser;
// Typed structurally: pulling in lib "webworker" would clash with the DOM lib
// the rest of the app compiles against.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<HeaderJob>) => void) | null;
  postMessage: (message: HeaderJobResult) => void;
};

scope.onmessage = async (event: MessageEvent<HeaderJob>) => {
  const { id, file, name } = event.data;
  let result: HeaderJobResult;
  try {
    const header = await parseLocalHeaderProgressive(parser, name, file.size, async (end) =>
      new Uint8Array(await file.slice(0, end).arrayBuffer())
    );
    result = { id, header };
  } catch {
    result = { id, header: null, failed: true };
  }
  scope.postMessage(result);
};
