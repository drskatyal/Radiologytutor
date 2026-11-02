// ============================================================================
// lib/anonymizeTeachingDicom.ts
//
// Mint a teaching DICOM by blanking residual identity tags on an Explicit VR
// Little Endian Part-10 file (zero-length, value removed). Pixel bytes are
// copied through. This is the generator for public/dicom/teach_anon_mr.dcm.
//
// Teacher uploads do not call this. They go through lib/teachingDeidentify.ts,
// which blanks the same identity tags and remaps UIDs before the ingest gate.
// ============================================================================

import { BLOCKING_PHI_TAGS } from "./deid";

/** Keyword → numeric tag for every ingest-blocking identity attribute. */
export const BLOCKING_TAG_HEX: Record<(typeof BLOCKING_PHI_TAGS)[number], string> = {
  PatientName: "00100010",
  PatientID: "00100020",
  PatientBirthDate: "00100030",
  PatientBirthTime: "00100032",
  PatientAddress: "00101040",
  PatientTelephoneNumbers: "00102154",
  OtherPatientIDs: "00101000",
  OtherPatientNames: "00101001",
  OtherPatientIDsSequence: "00101002",
  ReferringPhysicianName: "00080090",
  PerformingPhysicianName: "00081050",
  OperatorsName: "00081070",
  PhysiciansOfRecord: "00081048",
  NameOfPhysiciansReadingStudy: "00081060",
};

const EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";
const LONG_VR = new Set(["OB", "OW", "OF", "SQ", "UT", "UN", "OD", "OL", "UC", "UR", "UV", "SV"]);
const UNDEF = 0xffffffff;

const BLANK = new Set<string>(Object.values(BLOCKING_TAG_HEX));

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function writeU32(b: Uint8Array, o: number, value: number): void {
  b[o] = value & 0xff;
  b[o + 1] = (value >>> 8) & 0xff;
  b[o + 2] = (value >>> 16) & 0xff;
  b[o + 3] = (value >>> 24) & 0xff;
}

function tagHex(b: Uint8Array, o: number): string {
  return (
    u16(b, o).toString(16).padStart(4, "0").toUpperCase() +
    u16(b, o + 2).toString(16).padStart(4, "0").toUpperCase()
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function zeroedHeader(src: Uint8Array, off: number, long: boolean): Uint8Array {
  const header = src.slice(off, off + (long ? 12 : 8));
  if (long) writeU32(header, 8, 0);
  else header[6] = header[7] = 0;
  return header;
}

interface Rewritten {
  bytes: Uint8Array;
  /** Numeric tags whose values were removed. */
  removed: string[];
}

/**
 * Rewrite one dataset region (top-level or a sequence item's value). Defined
 * lengths only — undefined-length sequences throw so we never emit a corrupt
 * teaching file.
 */
function rewriteRange(src: Uint8Array, start: number, end: number): Rewritten {
  const parts: Uint8Array[] = [];
  const removed: string[] = [];
  let off = start;

  while (off + 8 <= end) {
    const tag = tagHex(src, off);

    // Item / delimiter. Defined-length items are rewritten so a PatientName
    // nested in a sequence is blanked and the item length stays honest.
    if (tag === "FFFEE000" || tag === "FFFEE00D" || tag === "FFFEE0DD") {
      const length = u32(src, off + 4);
      if (length === UNDEF) {
        throw new Error(`Undefined-length item ${tag} is not supported`);
      }
      if (tag !== "FFFEE000") {
        parts.push(src.slice(off, off + 8));
        off += 8;
        continue;
      }
      const valueOff = off + 8;
      const valueEnd = valueOff + length;
      if (valueEnd > end) throw new Error(`DICOM item at ${off} overruns the dataset`);
      const inner = rewriteRange(src, valueOff, valueEnd);
      const header = new Uint8Array(8);
      header.set(src.subarray(off, off + 4));
      writeU32(header, 4, inner.bytes.length);
      parts.push(header, inner.bytes);
      removed.push(...inner.removed);
      off = valueEnd;
      continue;
    }

    const vr = String.fromCharCode(src[off + 4], src[off + 5]);
    if (!/^[A-Z]{2}$/.test(vr)) {
      throw new Error(`Not explicit VR at offset ${off} (need Explicit VR Little Endian)`);
    }
    const long = LONG_VR.has(vr);
    const length = long ? u32(src, off + 8) : u16(src, off + 6);
    const headerLen = long ? 12 : 8;
    const valueOff = off + headerLen;
    if (length === UNDEF) {
      throw new Error(`Undefined-length ${vr} ${tag} is not supported`);
    }
    if (valueOff + length > end) throw new Error(`Element ${tag} overruns the dataset`);

    if (BLANK.has(tag) && length > 0) {
      parts.push(zeroedHeader(src, off, long));
      removed.push(tag);
      off = valueOff + length;
      continue;
    }

    if (vr === "SQ" && length > 0) {
      const inner = rewriteRange(src, valueOff, valueOff + length);
      const header = new Uint8Array(12);
      header.set(src.subarray(off, off + 8));
      writeU32(header, 8, inner.bytes.length);
      parts.push(header, inner.bytes);
      removed.push(...inner.removed);
      off = valueOff + length;
      continue;
    }

    parts.push(src.slice(off, valueOff + length));
    off = valueOff + length;
  }

  if (off < end) parts.push(src.slice(off, end));
  return { bytes: concat(parts), removed };
}

function transferSyntax(bytes: Uint8Array): string {
  if (bytes.length < 132) throw new Error("Not a Part-10 DICOM file");
  const magic = String.fromCharCode(bytes[128], bytes[129], bytes[130], bytes[131]);
  if (magic !== "DICM") throw new Error("Not a Part-10 DICOM file");
  let off = 132;
  while (off + 8 <= bytes.length) {
    const tag = tagHex(bytes, off);
    if (!tag.startsWith("0002")) break;
    const vr = String.fromCharCode(bytes[off + 4], bytes[off + 5]);
    const long = LONG_VR.has(vr);
    const length = long ? u32(bytes, off + 8) : u16(bytes, off + 6);
    const headerLen = long ? 12 : 8;
    if (length === UNDEF) throw new Error("Undefined length in the file meta information");
    if (tag === "00020010") {
      return new TextDecoder()
        .decode(bytes.subarray(off + headerLen, off + headerLen + length))
        .replace(/\0/g, "")
        .trim();
    }
    off += headerLen + length;
  }
  throw new Error("Missing Transfer Syntax UID");
}

export interface BlankedDicom {
  bytes: Uint8Array;
  /** Numeric tags whose values were removed. */
  removed: string[];
}

/**
 * Remove values of blocking identity tags. Empty tags stay empty. Pixels and
 * every non-identity element are preserved. Throws if the file is not
 * Explicit VR Little Endian Part-10.
 */
export function blankBlockingIdentityTags(input: Uint8Array): BlankedDicom {
  const ts = transferSyntax(input);
  if (ts !== EXPLICIT_VR_LE) {
    throw new Error(`Refusing to rewrite transfer syntax ${ts}; need ${EXPLICIT_VR_LE}`);
  }
  const body = rewriteRange(input, 132, input.length);
  return { bytes: concat([input.slice(0, 132), body.bytes]), removed: body.removed };
}
