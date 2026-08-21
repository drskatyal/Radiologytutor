// ============================================================================
// lib/deid.ts
//
// De-identification quality gate for teaching-case ingest (CLAUDE.md §4a / §6).
// This is NOT a HIPAA compliance program — we do not claim Safe Harbor, we do
// not fake pixel OCR, and we do not pass a study just because a script ran.
//
// What this seam does now:
//   1. scrubDicomTags(dataset) — strip identity tags from a tag map
//      (Orthanc MainDicomTags-shaped objects, or keyword/numeric dumps).
//   2. inspectDicomTags / inspectDicomBytes — build a DeidReport.
//   3. evaluateDeid(report) — pass/fail on residual *identity* tags.
//
// Pixel OCR for burned-in PHI is explicitly unscanned (`pixelOcrScanned: false`)
// until lib/deid grows that scanner. Publish can still require a passing
// header report; claiming OCR ran would be theater.
//
// Hooked from orthancIngestInstance so every stored instance is gated.
// ============================================================================

import { parseDicom } from "dicom-parser";

export type DeidStatus = "pass" | "fail" | "manual_override" | "pending";

/** One residual identifier found in a dataset. */
export interface PhiHit {
  tag: string;
  reason: string;
  /** When false, listed on the report but does not fail evaluateDeid. */
  blocking: boolean;
}

/**
 * Per-study (or per-instance) de-id report. Matches ARCHITECTURE.md §2.2:
 * publishing is blocked unless every referenced study has a passing report.
 */
export interface DeidReport {
  studyId?: string;
  studyInstanceUID?: string;
  headerScrubbed: boolean;
  /** False until a real pixel-OCR pass exists. Never implied true. */
  pixelOcrScanned: boolean;
  findings: PhiHit[];
  status: DeidStatus;
  reviewerId?: string;
  inspectedAt: string;
}

export interface DeidVerdict {
  pass: boolean;
  status: DeidStatus;
  blocking: PhiHit[];
}

/** Identity tags that fail the ingest gate if they still hold a real value. */
export const BLOCKING_PHI_TAGS = [
  "PatientName",
  "PatientID",
  "PatientBirthDate",
  "PatientBirthTime",
  "PatientAddress",
  "PatientTelephoneNumbers",
  "OtherPatientIDs",
  "OtherPatientNames",
  "OtherPatientIDsSequence",
  "ReferringPhysicianName",
  "PerformingPhysicianName",
  "OperatorsName",
  "PhysiciansOfRecord",
  "NameOfPhysiciansReadingStudy",
] as const;

/**
 * Additional tags we strip from a tag map (institution/station/comments) but
 * that do not fail ingest — teaching files often keep a department name, and
 * failing every CTA from "Anon Hospital" would be noise, not a quality gate.
 */
export const SCRUB_ONLY_TAGS = [
  "InstitutionName",
  "InstitutionAddress",
  "InstitutionalDepartmentName",
  "StationName",
  "DeviceSerialNumber",
  "EthnicGroup",
  "Occupation",
  "AdditionalPatientHistory",
  "PatientComments",
  "IssuerOfPatientID",
] as const;

/** Keyword + numeric forms we recognise on dataset-like objects. */
const NUMERIC_TAG_ALIASES: Record<string, string> = {
  "00100010": "PatientName",
  "00100020": "PatientID",
  "00100030": "PatientBirthDate",
  "00100032": "PatientBirthTime",
  "00101040": "PatientAddress",
  "00102154": "PatientTelephoneNumbers",
  "00101000": "OtherPatientIDs",
  "00101001": "OtherPatientNames",
  "00080080": "InstitutionName",
  "00080081": "InstitutionAddress",
  "00080090": "ReferringPhysicianName",
  "00081050": "PerformingPhysicianName",
  "00081070": "OperatorsName",
  "00081010": "StationName",
  "00080050": "AccessionNumber",
};

const DICOM_PARSER_TAGS: { keyword: string; hex: string; blocking: boolean }[] = [
  { keyword: "PatientName", hex: "x00100010", blocking: true },
  { keyword: "PatientID", hex: "x00100020", blocking: true },
  { keyword: "PatientBirthDate", hex: "x00100030", blocking: true },
  { keyword: "PatientBirthTime", hex: "x00100032", blocking: true },
  { keyword: "PatientAddress", hex: "x00101040", blocking: true },
  { keyword: "PatientTelephoneNumbers", hex: "x00102154", blocking: true },
  { keyword: "OtherPatientIDs", hex: "x00101000", blocking: true },
  { keyword: "OtherPatientNames", hex: "x00101001", blocking: true },
  { keyword: "ReferringPhysicianName", hex: "x00080090", blocking: true },
  { keyword: "PerformingPhysicianName", hex: "x00081050", blocking: true },
  { keyword: "OperatorsName", hex: "x00081070", blocking: true },
  { keyword: "PhysiciansOfRecord", hex: "x00081048", blocking: true },
  { keyword: "NameOfPhysiciansReadingStudy", hex: "x00081060", blocking: true },
  { keyword: "InstitutionName", hex: "x00080080", blocking: false },
  { keyword: "InstitutionAddress", hex: "x00080081", blocking: false },
  { keyword: "StationName", hex: "x00081010", blocking: false },
  { keyword: "StudyInstanceUID", hex: "x0020000d", blocking: false },
];

/** Values that mean "already de-identified", not residual PHI. */
const SENTINEL =
  /^(anonymous|anon|unknown|removed|redacted|deidentified|de-identified|patient|xxxx+|-+|\^|\s)*$/i;

/**
 * TCIA / NCI public collections label subjects with collection-prefixed research
 * pseudonyms (e.g. `LIDC-IDRI-0957`) rather than clinical MRNs. Those are already
 * de-identified at source, so refusing them would block importing public research
 * data — but they are NOT safe to accept from an arbitrary uploader.
 *
 * This allowance is therefore OPT-IN and off by default: only the curated public
 * importer passes `allowResearchPseudonyms`, never `/api/upload`. A teacher
 * uploading a real study still fails the gate on any present PatientID/PatientName.
 *
 * The pattern is a FULL match (collection prefix + separator + alphanumeric subject
 * id), not a prefix test, so free text that merely starts with a collection name
 * ("NSCLC screening — Jane Doe") does not slip through.
 */
const RESEARCH_PSEUDONYM_ID =
  /^(LIDC-IDRI|PD-1-Lung|Anti-PD-1|UPENN-GBM|Soft-Tissue|PROSTATE|RIDER|TCGA|NSCLC|LUNG1|QIN|TCIA|Colon)[-_][A-Za-z0-9][A-Za-z0-9-_]{0,31}$/i;

/**
 * True when `value` is a recognised public-collection research pseudonym.
 * Only consulted when the caller opts in via `allowResearchPseudonyms`.
 */
export function isTciaResearchPseudonymId(value: unknown): boolean {
  const s = String(value ?? "").trim();
  if (!s) return false;
  return RESEARCH_PSEUDONYM_ID.test(s);
}

/** Options for the header inspection pass. Defaults are the strict ones. */
export interface DeidInspectOptions {
  /**
   * Accept TCIA-style research pseudonyms in PatientID/PatientName instead of
   * failing on them. Curated public-collection imports only — never set this
   * for an operator-supplied upload.
   */
  allowResearchPseudonyms?: boolean;
}

function isPresent(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value).trim();
  return s.length > 0;
}

function isSentinel(value: unknown): boolean {
  const s = String(value).trim();
  if (s.length === 0) return true;
  return SENTINEL.test(s);
}

function keywordFor(key: string): string {
  const compact = key.replace(/[(),\s]/g, "");
  return NUMERIC_TAG_ALIASES[compact] ?? key;
}

const SCRUB_SET = new Set<string>([...BLOCKING_PHI_TAGS, ...SCRUB_ONLY_TAGS]);

/**
 * Remove known PHI keys from a plain tag map (e.g. Orthanc MainDicomTags).
 * Returns a new object; never invents replacement IDs beyond clearing.
 */
export function scrubDicomTags(
  tags: Record<string, unknown>
): { scrubbed: Record<string, unknown>; removed: string[] } {
  const scrubbed: Record<string, unknown> = { ...tags };
  const removed: string[] = [];
  for (const key of Object.keys(scrubbed)) {
    const keyword = keywordFor(key);
    if (!SCRUB_SET.has(keyword)) continue;
    if (!isPresent(scrubbed[key])) continue;
    delete scrubbed[key];
    removed.push(key);
  }
  return { scrubbed, removed };
}

function hitFor(
  tag: string,
  value: unknown,
  blocking: boolean,
  opts: DeidInspectOptions = {}
): PhiHit | null {
  if (!isPresent(value)) return null;
  if (
    blocking &&
    opts.allowResearchPseudonyms &&
    (tag === "PatientID" || tag === "PatientName") &&
    isTciaResearchPseudonymId(value)
  ) {
    return null;
  }
  if (blocking && isSentinel(value)) return null;
  if (!blocking) {
    // Institution/station: record but do not fail ingest.
    return {
      tag,
      reason: "Non-identity tag present (scrubbed from maps; not an ingest blocker)",
      blocking: false,
    };
  }
  return {
    tag,
    reason: "Residual identity / PHI value",
    blocking: true,
  };
}

/** Build a DeidReport from a dataset-like tag map. Does not set pass/fail. */
export function inspectDicomTags(
  tags: Record<string, unknown>,
  studyInstanceUID?: string,
  opts: DeidInspectOptions = {}
): DeidReport {
  const findings: PhiHit[] = [];
  const seen = new Set<string>();

  const consider = (rawKey: string, blocking: boolean) => {
    const keyword = keywordFor(rawKey);
    const value = tags[rawKey] ?? tags[keyword];
    const hit = hitFor(keyword, value, blocking, opts);
    if (!hit || seen.has(hit.tag)) return;
    seen.add(hit.tag);
    findings.push(hit);
  };

  for (const key of BLOCKING_PHI_TAGS) consider(key, true);
  for (const key of Object.keys(tags)) {
    const keyword = keywordFor(key);
    if (BLOCKING_PHI_TAGS.includes(keyword as (typeof BLOCKING_PHI_TAGS)[number])) {
      consider(key, true);
    }
  }
  for (const key of SCRUB_ONLY_TAGS) consider(key, false);

  const uid =
    studyInstanceUID ||
    (typeof tags.StudyInstanceUID === "string" ? tags.StudyInstanceUID : undefined);

  const report: DeidReport = {
    studyInstanceUID: uid,
    headerScrubbed: findings.filter((f) => f.blocking).length === 0,
    pixelOcrScanned: false,
    findings,
    status: "pending",
    inspectedAt: new Date().toISOString(),
  };
  const verdict = evaluateDeid(report);
  return { ...report, status: verdict.status };
}

/**
 * Pass/fail a DeidReport. Residual blocking identity tags fail.
 * `manual_override` always passes (human reviewed). Pixel OCR is not required
 * here — we do not invent a scan that did not happen.
 */
export function evaluateDeid(report: DeidReport): DeidVerdict {
  if (report.status === "manual_override") {
    return { pass: true, status: "manual_override", blocking: [] };
  }
  const blocking = report.findings.filter((f) => f.blocking);
  const pass = blocking.length === 0;
  return { pass, status: pass ? "pass" : "fail", blocking };
}

export function deidAllowsPublish(report: DeidReport | null | undefined): boolean {
  if (!report) return false;
  return evaluateDeid(report).pass;
}

export class DeidFailError extends Error {
  readonly code = "DEID_FAIL" as const;
  readonly report: DeidReport;
  constructor(report: DeidReport) {
    const tags = evaluateDeid(report)
      .blocking.map((f) => f.tag)
      .join(", ");
    super(
      tags
        ? `DEID_FAIL: residual identifiers (${tags})`
        : "DEID_FAIL: DICOM headers could not be verified"
    );
    this.name = "DeidFailError";
    this.report = report;
  }
}

/** Parse Part-10 bytes and inspect identity tags. Unreadable headers fail. */
export function inspectDicomBytes(
  bytes: ArrayBuffer,
  opts: DeidInspectOptions = {}
): DeidReport {
  try {
    const byteArray = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dataSet = parseDicom(byteArray);
    const tags: Record<string, unknown> = {};
    for (const spec of DICOM_PARSER_TAGS) {
      const value = dataSet.string(spec.hex);
      if (value) tags[spec.keyword] = value;
    }
    return inspectDicomTags(tags, undefined, opts);
  } catch {
    return {
      headerScrubbed: false,
      pixelOcrScanned: false,
      findings: [
        {
          tag: "dataset",
          reason: "Unreadable DICOM headers — cannot verify de-identification",
          blocking: true,
        },
      ],
      status: "fail",
      inspectedAt: new Date().toISOString(),
    };
  }
}

/** Throw DeidFailError unless the instance's headers pass the identity gate. */
export function assertDeidPass(report: DeidReport): void {
  if (!evaluateDeid(report).pass) throw new DeidFailError(report);
}
