// Server-side identity gate for a stored instance. The browser anonymised the
// file; this re-checks it before anything reaches the archive.

import { parseDicom } from "dicom-parser";
import { evaluateDeid, inspectDicomBytes } from "@/lib/deid";
import { ANON_UID_RE } from "./studyInput";

/** Why an instance is refused, or null when it may be stored.  */
export function instanceRefusal(bytes: Uint8Array, studyInstanceUID: string): string | null {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const verdict = evaluateDeid(inspectDicomBytes(ab));
  if (!verdict.pass) return `Patient identifiers remain (${verdict.blocking.map((b) => b.tag).join(", ")}).`;
  let ds;
  try {
    ds = parseDicom(bytes, { untilTag: "x7fe00010" });
  } catch {
    return "Not a readable DICOM file.";
  }
  if (ds.string("x00120062") !== "YES") return "The file was not anonymised by FlowRad Viewer.";
  if (ds.string("x0020000d") !== studyInstanceUID) return "This file belongs to a different study.";
  const series = ds.string("x0020000e") ?? "";
  const sop = ds.string("x00080018") ?? "";
  if (!ANON_UID_RE.test(series) || !ANON_UID_RE.test(sop)) return "Instance UIDs were not anonymised.";
  return null;
}

