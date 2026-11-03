// A scan's headers, rebuilt from the batches that streamed them.
//
// The Rust scan streams every header to the page in batches while it reads
// (progressive open), and used to send them all once more in its result. On
// the 10,310-image MRI that second copy was a ~15 MB response: its JSON parse
// and the garbage it left were the open's last long task ("no script: GC or
// engine-internal", 53 ms on CI). Now the result says how many headers were
// streamed and carries only what changed after streaming: the patient fields
// of cache hits (the scan cache holds no patient identifiers; scan.rs). This
// module turns the batches back into exactly the list the result used to hold.

import type { DesktopHeader } from "./types";

/** One study's patient fields and the file ids they apply to (scan.rs `PatientPatch`). */
export interface PatientPatch {
  fileIds: number[];
  fields: Partial<DesktopHeader>;
}

// UTF-16 code units in U+E000..U+FFFF sort above surrogates in UTF-16 but
// below the astral code points those surrogates encode in UTF-8 / code-point
// order (Rust's `String` order). Only names with such units need the slow path.
const NEEDS_CODE_POINT_ORDER = /[\uD800-￿]/;

function unitKey(u: number): number {
  if (u >= 0xe000) return u - 0x800;
  if (u >= 0xd800) return u + 0x2000;
  return u;
}

/** Rust's `str` order (UTF-8 bytes = code points), for any two JS strings. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return unitKey(x) - unitKey(y);
  }
  return a.length - b.length;
}

/**
 * The scan result's header list from its streamed batches: patient patches
 * applied (in place: the headers belong to this open) and sorted by file name
 * the way scan.rs sorts them, so grouping sees the same input as before.
 */
export function assembleStreamedHeaders(streamed: DesktopHeader[], patches: readonly PatientPatch[] = []): DesktopHeader[] {
  if (patches.length) {
    const byId = new Map<number, Partial<DesktopHeader>>();
    for (const patch of patches) for (const id of patch.fileIds) byId.set(id, patch.fields);
    for (const h of streamed) {
      const fields = byId.get(h.fileId);
      if (fields) Object.assign(h, fields);
    }
  }
  const slow = streamed.some((h) => NEEDS_CODE_POINT_ORDER.test(h.fileName));
  return streamed.sort(
    slow
      ? (a, b) => compareCodePoints(a.fileName, b.fileName)
      : (a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0)
  );
}
