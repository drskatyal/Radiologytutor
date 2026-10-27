// ============================================================================
// lib/teachingDeidentify.ts
//
// Automatic header de-identification for authenticated teacher uploads
// (POST /api/upload → ingestUpload). Real clinical DICOM is rewritten before
// the ingest gate and before STOW. This is not a HIPAA Safe Harbor claim and
// it does not scan pixels for burned-in text.
//
// Policy for a teaching case:
//   • Blank identity, physician, institution, accession, and device-serial tags
//     (every tag in BLOCKING_PHI_TAGS, plus the scrub-only set, plus accession
//     and study id). Nested copies inside sequences are blanked too.
//   • Drop odd-group private elements (vendor blocks often carry identifiers).
//   • Remap non-standard UIDs deterministically so a study split across upload
//     batches stays one study, and a re-export of the same instance collides
//     with itself instead of forking. SOP Class, transfer syntax, and any
//     1.2.840.10008.* UID are left alone.
//   • Keep pixel data byte-for-byte, including encapsulated fragments.
//   • Keep descriptions, study/series dates, patient sex, and patient age.
//
// Curated public imports do not call this. They go through orthancIngestInstance,
// which still refuses residual identity tags.
// ============================================================================

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { BLOCKING_TAG_HEX } from "./anonymizeTeachingDicom";

export const TEACHING_DEID_FAILURE =
  "couldn't remove patient identifiers from this file";

export class TeachingDeidError extends Error {
  readonly userMessage = TEACHING_DEID_FAILURE;
  constructor(detail: string) {
    super(detail);
    this.name = "TeachingDeidError";
  }
}

const IMPLICIT_LE = "1.2.840.10008.1.2";
const EXPLICIT_LE = "1.2.840.10008.1.2.1";
const DEFLATED_EXPLICIT_LE = "1.2.840.10008.1.2.1.99";
const BIG_ENDIAN_EXPLICIT = "1.2.840.10008.1.2.2";

const UNDEF = 0xffffffff;
const LONG_VR = new Set([
  "OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV",
]);

/**
 * Tags cleared on teacher upload. Hex, uppercase, no comma.
 * Blocking identity tags are included via BLOCKING_TAG_HEX so the ingest gate
 * and this rewriter cannot drift.
 */
const EXTRA_STRIP_TAGS = [
  "00080050", // AccessionNumber
  "00080051", // IssuerOfAccessionNumberSequence
  "00080080", // InstitutionName
  "00080081", // InstitutionAddress
  "00080082", // InstitutionCodeSequence
  "00080092", // ReferringPhysicianAddress
  "00080094", // ReferringPhysicianTelephoneNumbers
  "00080096", // ReferringPhysicianIdentificationSequence
  "0008009C", // ConsultingPhysicianName
  "0008009D", // ConsultingPhysicianIdentificationSequence
  "00081010", // StationName
  "00081040", // InstitutionalDepartmentName
  "00081049", // PhysiciansOfRecordIdentificationSequence
  "00081052", // PerformingPhysicianIdentificationSequence
  "00081062", // PhysiciansReadingStudyIdentificationSequence
  "00081072", // OperatorIdentificationSequence
  "00100021", // IssuerOfPatientID
  "00100024", // IssuerOfPatientIDQualifiersSequence
  "00101005", // PatientBirthName
  "00101060", // PatientMotherBirthName
  "00101090", // MedicalRecordLocator
  "00102155", // PatientTelecomInformation
  "00102160", // EthnicGroup
  "00102180", // Occupation
  "001021B0", // AdditionalPatientHistory
  "00104000", // PatientComments
  "00181000", // DeviceSerialNumber
  "00200010", // StudyID
  "00321032", // RequestingPhysician
  "00380010", // AdmissionID
  "00380011", // IssuerOfAdmissionID
  "00380300", // CurrentPatientLocation
  "00380400", // PatientInstitutionResidence
  "00400006", // ScheduledPerformingPhysicianName
  "0040000B", // ScheduledPerformingPhysicianIdentificationSequence
  "00401001", // RequestedProcedureID
  "00402016", // PlacerOrderNumberImagingServiceRequest
  "00402017", // FillerOrderNumberImagingServiceRequest
] as const;

export const TEACHING_STRIP_TAGS: ReadonlySet<string> = new Set([
  ...Object.values(BLOCKING_TAG_HEX),
  ...EXTRA_STRIP_TAGS,
]);

/** UID tags we never rewrite (class and transfer syntax, not instance identity). */
const KEEP_UID_TAGS = new Set([
  "00020002", // MediaStorageSOPClassUID
  "00020010", // TransferSyntaxUID
  "00080016", // SOPClassUID
  "00081150", // ReferencedSOPClassUID
]);

/**
 * UID tags recognised when the dataset is implicit VR (no VR byte to consult).
 * Explicit VR uses the UI value representation and does not need this list.
 */
const IMPLICIT_UID_TAGS = new Set([
  ...KEEP_UID_TAGS,
  "00020003", // MediaStorageSOPInstanceUID
  "00020012", // ImplementationClassUID
  "00080014", // InstanceCreatorUID
  "00080018", // SOPInstanceUID
  "00081155", // ReferencedSOPInstanceUID
  "00083010", // IrradiationEventUID
  "0020000D", // StudyInstanceUID
  "0020000E", // SeriesInstanceUID
  "00200052", // FrameOfReferenceUID
  "00209164", // DimensionOrganizationUID
]);

const PIXEL_TAGS = new Set(["7FE00008", "7FE00009", "7FE00010"]);

export interface TeachingDeidResult {
  bytes: Uint8Array;
  /** Numeric tags whose values were removed. */
  removed: string[];
  /** Numeric UID tags that were replaced. */
  remapped: string[];
}

/**
 * Deterministic DICOM UID for a teaching copy of `original`.
 * Same input always yields the same UID, so batches of one study stay together.
 * The result is a 2.25 UUID-derived UID (digits and dots, ≤ 64 chars).
 */
export function remapTeachingUid(original: string): string {
  const digest = createHash("sha256")
    .update("radlearn-teaching-uid-v1\0")
    .update(original)
    .digest();
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(digest[i]!);
  const uid = `2.25.${n.toString(10)}`;
  if (uid.length > 64 || !/^[0-9.]+$/.test(uid)) {
    throw new TeachingDeidError("Remapped UID is not a valid DICOM UID");
  }
  return uid;
}

interface Ctx {
  explicit: boolean;
  removed: string[];
  remapped: string[];
  replaceUid: Map<string, string>;
}

interface Rewritten {
  bytes: Uint8Array;
  endOffset: number;
}

export function deidentifyTeachingInstance(input: Uint8Array): TeachingDeidResult {
  try {
    return rewritePart10(input);
  } catch (e) {
    if (e instanceof TeachingDeidError) throw e;
    throw new TeachingDeidError(e instanceof Error ? e.message : "Could not rewrite DICOM");
  }
}

function rewritePart10(input: Uint8Array): TeachingDeidResult {
  if (input.length < 132) throw new TeachingDeidError("Not a Part-10 DICOM file");
  const magic = String.fromCharCode(input[128]!, input[129]!, input[130]!, input[131]!);
  if (magic !== "DICM") throw new TeachingDeidError("Not a Part-10 DICOM file");

  const { metaEnd, transferSyntax } = findMetaEnd(input);
  const removed: string[] = [];
  const remapped: string[] = [];
  const replaceUid = new Map<string, string>();

  let dataset: Uint8Array;
  let explicit: boolean;
  if (transferSyntax === IMPLICIT_LE) {
    explicit = false;
    dataset = input.subarray(metaEnd);
  } else if (transferSyntax === DEFLATED_EXPLICIT_LE) {
    explicit = true;
    replaceUid.set("00020010", EXPLICIT_LE);
    try {
      dataset = inflateRawSync(Buffer.from(input.subarray(metaEnd)));
    } catch {
      throw new TeachingDeidError("Could not inflate the DICOM dataset");
    }
  } else if (transferSyntax === BIG_ENDIAN_EXPLICIT) {
    throw new TeachingDeidError("Explicit VR big endian is not supported");
  } else {
    // Explicit LE, and the compressed syntaxes (JPEG, J2K, RLE, JPEG-LS),
    // which encode the dataset as Explicit VR Little Endian.
    explicit = true;
    dataset = input.subarray(metaEnd);
  }

  const metaSrc = input.subarray(132, metaEnd);
  const metaCtx: Ctx = { explicit: true, removed, remapped, replaceUid };
  const meta = rewriteStream(metaSrc, 0, metaSrc.length, metaCtx, false);
  const dataCtx: Ctx = { explicit, removed, remapped, replaceUid: new Map() };
  const body = rewriteStream(dataset, 0, dataset.length, dataCtx, false);

  return {
    bytes: concat([input.subarray(0, 132), withGroupLength(meta.bytes), body.bytes]),
    removed,
    remapped,
  };
}

function findMetaEnd(src: Uint8Array): { metaEnd: number; transferSyntax: string } {
  let off = 132;
  let transferSyntax = "";
  while (off + 8 <= src.length) {
    const tag = tagHex(src, off);
    if (!tag.startsWith("0002")) return requireTs(off, transferSyntax);
    const el = readExplicit(src, off);
    if (el.length === UNDEF) throw new TeachingDeidError("Undefined length in the file meta information");
    if (el.valueOff + el.length > src.length) {
      throw new TeachingDeidError("File meta element overruns the file");
    }
    if (tag === "00020010") {
      transferSyntax = decodeBytes(src.subarray(el.valueOff, el.valueOff + el.length));
    }
    off = el.valueOff + el.length;
  }
  return requireTs(off, transferSyntax);
}

function requireTs(metaEnd: number, transferSyntax: string): { metaEnd: number; transferSyntax: string } {
  if (!transferSyntax) throw new TeachingDeidError("Missing Transfer Syntax UID");
  return { metaEnd, transferSyntax };
}

function rewriteStream(
  src: Uint8Array,
  start: number,
  limit: number,
  ctx: Ctx,
  stopAtDelim: boolean
): Rewritten {
  const parts: Uint8Array[] = [];
  let off = start;

  while (off + 8 <= limit) {
    const tag = tagHex(src, off);
    if (stopAtDelim && (tag === "FFFEE00D" || tag === "FFFEE0DD")) {
      return { bytes: concat(parts), endOffset: off };
    }

    const el = ctx.explicit && !tag.startsWith("FFFE") ? readExplicit(src, off) : readImplicit(src, off);
    if (el.valueOff > limit) throw new TeachingDeidError(`Element ${tag} overruns the dataset`);

    if (PIXEL_TAGS.has(tag)) {
      const end = el.length === UNDEF ? encapsulatedEnd(src, el.valueOff, limit) : bounded(el.valueOff, el.length, limit, tag);
      parts.push(src.subarray(off, end));
      off = end;
      continue;
    }

    if (isPrivate(tag)) {
      off = el.length === UNDEF ? encapsulatedEnd(src, el.valueOff, limit) : bounded(el.valueOff, el.length, limit, tag);
      continue;
    }

    if (isGroupLength(tag)) {
      if (el.length === UNDEF) throw new TeachingDeidError(`Undefined group length ${tag}`);
      off = bounded(el.valueOff, el.length, limit, tag);
      continue;
    }

    if (TEACHING_STRIP_TAGS.has(tag)) {
      if (el.length === UNDEF || el.length > 0) ctx.removed.push(tag);
      parts.push(blankElement(tag, el.vr, ctx.explicit));
      off = el.length === UNDEF ? encapsulatedEnd(src, el.valueOff, limit) : bounded(el.valueOff, el.length, limit, tag);
      continue;
    }

    const replaced = rewriteUid(src, tag, el, ctx);
    if (replaced) {
      parts.push(replaced);
      ctx.remapped.push(tag);
      if (el.length === UNDEF) throw new TeachingDeidError(`Undefined-length UID ${tag}`);
      off = bounded(el.valueOff, el.length, limit, tag);
      continue;
    }

    if (isSequence(src, tag, el, limit)) {
      const undefinedLength = el.length === UNDEF;
      const seqLimit = undefinedLength ? limit : bounded(el.valueOff, el.length, limit, tag);
      const seq = consumeSequence(src, el.valueOff, seqLimit, ctx, undefinedLength);
      parts.push(writeElement(tag, "SQ", seq.bytes, ctx.explicit));
      off = undefinedLength ? seq.endOffset : seqLimit;
      continue;
    }

    if (el.length === UNDEF) throw new TeachingDeidError(`Undefined-length element ${tag} is not supported`);
    const end = bounded(el.valueOff, el.length, limit, tag);
    parts.push(src.subarray(off, end));
    off = end;
  }

  if (stopAtDelim) throw new TeachingDeidError("Unterminated undefined-length item");
  if (off < limit) {
    if (limit - off < 8) parts.push(src.subarray(off, limit));
    else throw new TeachingDeidError(`Trailing ${limit - off} bytes are not a DICOM element`);
  }
  return { bytes: concat(parts), endOffset: limit };
}

function consumeSequence(
  src: Uint8Array,
  valueOff: number,
  limit: number,
  ctx: Ctx,
  undefinedLength: boolean
): Rewritten {
  const parts: Uint8Array[] = [];
  let off = valueOff;
  while (off + 8 <= limit) {
    const tag = tagHex(src, off);
    if (tag === "FFFEE0DD") {
      return { bytes: concat(parts), endOffset: off + 8 };
    }
    if (tag !== "FFFEE000") {
      throw new TeachingDeidError(`Expected a sequence item at offset ${off}`);
    }
    const length = u32(src, off + 4);
    if (length === UNDEF) {
      const inner = rewriteStream(src, off + 8, limit, ctx, true);
      if (tagHex(src, inner.endOffset) !== "FFFEE00D") {
        throw new TeachingDeidError("Undefined-length item is missing its delimiter");
      }
      parts.push(writeItem(inner.bytes));
      off = inner.endOffset + 8;
      continue;
    }
    const itemEnd = bounded(off + 8, length, limit, "FFFEE000");
    const inner = rewriteStream(src, off + 8, itemEnd, ctx, false);
    parts.push(writeItem(inner.bytes));
    off = itemEnd;
  }
  if (undefinedLength) throw new TeachingDeidError("Unterminated undefined-length sequence");
  return { bytes: concat(parts), endOffset: limit };
}

function rewriteUid(
  src: Uint8Array,
  tag: string,
  el: Header,
  ctx: Ctx
): Uint8Array | null {
  const forced = ctx.replaceUid.get(tag);
  const isUid = el.vr === "UI" || (!el.vr && IMPLICIT_UID_TAGS.has(tag)) || forced != null;
  if (!isUid || el.length === UNDEF || el.length === 0) return null;
  const current = decodeBytes(src.subarray(el.valueOff, el.valueOff + el.length));
  const next = forced ?? remapUidValue(tag, current);
  if (next == null || next === current) return null;
  return writeElement(tag, el.vr || "UI", encodeUi(next), ctx.explicit);
}

function remapUidValue(tag: string, value: string): string | null {
  if (!value || KEEP_UID_TAGS.has(tag)) return null;
  let changed = false;
  const next = value.split("\\").map((part) => {
    if (!part || part.startsWith("1.2.840.10008.")) return part;
    changed = true;
    return remapTeachingUid(part);
  });
  return changed ? next.join("\\") : null;
}

function isSequence(src: Uint8Array, tag: string, el: Header, limit: number): boolean {
  if (PIXEL_TAGS.has(tag)) return false;
  if (el.vr === "SQ") return true;
  if (el.vr && el.vr !== "UN") return false;
  if (el.length === UNDEF) return true;
  if (el.length < 8 || el.valueOff + 8 > limit) return false;
  if (tagHex(src, el.valueOff) !== "FFFEE000") return false;
  const group = Number.parseInt(tag.slice(0, 4), 16);
  // Overlay rows are binary and can accidentally look like an item tag.
  if (group >= 0x6000 && group <= 0x60ff) return false;
  return true;
}

function encapsulatedEnd(src: Uint8Array, valueOff: number, limit: number): number {
  let off = valueOff;
  while (off + 8 <= limit) {
    const tag = tagHex(src, off);
    const length = u32(src, off + 4);
    if (tag === "FFFEE0DD") return off + 8;
    if (tag !== "FFFEE000") throw new TeachingDeidError(`Unexpected tag ${tag} in encapsulated data`);
    if (length === UNDEF) {
      const delim = findTag(src, off + 8, limit, "FFFEE00D");
      off = delim + 8;
      continue;
    }
    off = bounded(off + 8, length, limit, tag);
  }
  throw new TeachingDeidError("Unterminated encapsulated pixel data");
}

function findTag(src: Uint8Array, start: number, limit: number, want: string): number {
  let off = start;
  while (off + 8 <= limit) {
    if (tagHex(src, off) === want) return off;
    const length = u32(src, off + 4);
    if (length === UNDEF) throw new TeachingDeidError("Nested undefined-length fragment is not supported");
    off = bounded(off + 8, length, limit, want);
  }
  throw new TeachingDeidError(`Missing delimiter ${want}`);
}

interface Header {
  vr?: string;
  length: number;
  valueOff: number;
}

function readExplicit(src: Uint8Array, off: number): Header {
  if (off + 8 > src.length) throw new TeachingDeidError("Truncated DICOM element");
  const vr = String.fromCharCode(src[off + 4]!, src[off + 5]!);
  if (!/^[A-Z]{2}$/.test(vr)) throw new TeachingDeidError(`Not explicit VR at offset ${off}`);
  const long = LONG_VR.has(vr);
  if (long && off + 12 > src.length) throw new TeachingDeidError("Truncated DICOM element");
  const length = long ? u32(src, off + 8) : u16(src, off + 6);
  const headerLen = long ? 12 : 8;
  return { vr, length, valueOff: off + headerLen };
}

function readImplicit(src: Uint8Array, off: number): Header {
  if (off + 8 > src.length) throw new TeachingDeidError("Truncated DICOM element");
  return { length: u32(src, off + 4), valueOff: off + 8 };
}

function blankElement(tag: string, vr: string | undefined, explicit: boolean): Uint8Array {
  const useVr = vr && /^[A-Z]{2}$/.test(vr) ? vr : "LO";
  return writeElement(tag, useVr, new Uint8Array(0), explicit);
}

function writeElement(tag: string, vr: string, value: Uint8Array, explicit: boolean): Uint8Array {
  if (!explicit || tag.startsWith("FFFE")) return writeImplicitElement(tag, value);
  const long = LONG_VR.has(vr);
  const header = new Uint8Array(long ? 12 : 8);
  writeTag(header, 0, tag);
  header[4] = vr.charCodeAt(0);
  header[5] = vr.charCodeAt(1);
  if (long) writeU32(header, 8, value.length);
  else {
    header[6] = value.length & 0xff;
    header[7] = (value.length >> 8) & 0xff;
  }
  return concat([header, value]);
}

function writeImplicitElement(tag: string, value: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  writeTag(header, 0, tag);
  writeU32(header, 4, value.length);
  return concat([header, value]);
}

function writeItem(content: Uint8Array): Uint8Array {
  return writeImplicitElement("FFFEE000", content);
}

function withGroupLength(metaBody: Uint8Array): Uint8Array {
  const value = new Uint8Array(4);
  writeU32(value, 0, metaBody.length);
  return concat([writeElement("00020000", "UL", value, true), metaBody]);
}

function encodeUi(uid: string): Uint8Array {
  const padded = uid.length % 2 === 0 ? uid : `${uid}\0`;
  return new TextEncoder().encode(padded);
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes).replace(/\0+$/g, "").trim();
}

function isPrivate(tag: string): boolean {
  return (Number.parseInt(tag.slice(0, 4), 16) & 1) === 1;
}

function isGroupLength(tag: string): boolean {
  return tag.endsWith("0000") && !tag.startsWith("FFFE");
}

function bounded(valueOff: number, length: number, limit: number, tag: string): number {
  const end = valueOff + length;
  if (length < 0 || end > limit) throw new TeachingDeidError(`Element ${tag} overruns the dataset`);
  return end;
}

function tagHex(b: Uint8Array, o: number): string {
  return (
    u16(b, o).toString(16).padStart(4, "0").toUpperCase() +
    u16(b, o + 2).toString(16).padStart(4, "0").toUpperCase()
  );
}

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function writeU32(b: Uint8Array, o: number, value: number): void {
  b[o] = value & 0xff;
  b[o + 1] = (value >>> 8) & 0xff;
  b[o + 2] = (value >>> 16) & 0xff;
  b[o + 3] = (value >>> 24) & 0xff;
}

function writeTag(b: Uint8Array, o: number, tag: string): void {
  const group = Number.parseInt(tag.slice(0, 4), 16);
  const element = Number.parseInt(tag.slice(4), 16);
  b[o] = group & 0xff;
  b[o + 1] = (group >> 8) & 0xff;
  b[o + 2] = element & 0xff;
  b[o + 3] = (element >> 8) & 0xff;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
