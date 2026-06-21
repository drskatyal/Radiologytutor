// Shared server-side coercion/validation for the exam-grade case-detail fields.
//
// Both the create (POST /api/admin/cases) and update (PATCH /api/admin/cases/
// [caseId]) routes accept the same teaching-detail fields; this keeps their
// validation in ONE place (canonical-list checks, trimming, array cleanup) so
// the two routes can never drift. Everything here is defensive: unknown enum
// values fall back to undefined rather than throwing, and blank strings/arrays
// collapse to undefined so we never persist empty noise.

import {
  PATIENT_SEXES,
  TARGET_LEVELS,
  type PatientSex,
  type TargetLevel,
} from "@/lib/types";

/** Trim a string field; empty → undefined (so we never store blanks). */
export function cleanStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

/** Clean a string[] field: trim, drop blanks; empty → undefined. */
export function cleanStrList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.map((x) => String(x).trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/** Validate against the canonical PATIENT_SEXES list. */
export function asPatientSex(v: unknown): PatientSex | undefined {
  return typeof v === "string" && (PATIENT_SEXES as string[]).includes(v)
    ? (v as PatientSex)
    : undefined;
}

/** Validate against the canonical TARGET_LEVELS list. */
export function asTargetLevel(v: unknown): TargetLevel | undefined {
  return typeof v === "string" && (TARGET_LEVELS as string[]).includes(v)
    ? (v as TargetLevel)
    : undefined;
}

/** The exam-grade detail fields as they arrive over the wire. */
export interface CaseDetailBody {
  clinicalHistory?: unknown;
  patientAge?: unknown;
  patientSex?: unknown;
  technique?: unknown;
  primaryDiagnosis?: unknown;
  differentials?: unknown;
  targetLevel?: unknown;
  learningObjectives?: unknown;
  discussion?: unknown;
  references?: unknown;
}

/** Coerced, validated exam-grade detail fields ready to persist. */
export interface CleanCaseDetails {
  clinicalHistory?: string;
  patientAge?: string;
  patientSex?: PatientSex;
  technique?: string;
  primaryDiagnosis?: string;
  differentials?: string[];
  targetLevel?: TargetLevel;
  learningObjectives?: string[];
  discussion?: string;
  references?: string[];
}

/**
 * Coerce all exam-grade detail fields from a request body. Used for CREATE
 * (every value passes straight through; undefined is fine). For PATCH the
 * caller decides which keys to apply (only those present in the body) — see
 * `pickPresentDetails`.
 */
export function coerceCaseDetails(body: CaseDetailBody): CleanCaseDetails {
  return {
    clinicalHistory: cleanStr(body.clinicalHistory),
    patientAge: cleanStr(body.patientAge),
    patientSex: asPatientSex(body.patientSex),
    technique: cleanStr(body.technique),
    primaryDiagnosis: cleanStr(body.primaryDiagnosis),
    differentials: cleanStrList(body.differentials),
    targetLevel: asTargetLevel(body.targetLevel),
    learningObjectives: cleanStrList(body.learningObjectives),
    discussion: cleanStr(body.discussion),
    references: cleanStrList(body.references),
  };
}

/**
 * For PATCH: only include a detail field in the patch when its key is actually
 * present in the body, so an omitted field is left unchanged (rather than
 * cleared). Present-but-blank clears it (undefined), which is the intended
 * "remove this field" semantics for an editable form.
 */
export function pickPresentDetails(
  body: Record<string, unknown> & CaseDetailBody
): CleanCaseDetails {
  const cleaned = coerceCaseDetails(body);
  const out: CleanCaseDetails = {};
  const keys: (keyof CleanCaseDetails)[] = [
    "clinicalHistory",
    "patientAge",
    "patientSex",
    "technique",
    "primaryDiagnosis",
    "differentials",
    "targetLevel",
    "learningObjectives",
    "discussion",
    "references",
  ];
  for (const k of keys) {
    if (k in body) (out as Record<string, unknown>)[k] = cleaned[k];
  }
  return out;
}
