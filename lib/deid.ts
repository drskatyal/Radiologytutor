// De-identification quality gate — scrub headers + report.
// Teaching marketplace: no PHI in published cases. Not a HIPAA compliance program.

export type DeidStatus = "pass" | "fail" | "pending" | "skipped";

export interface DeidFinding {
  tag: string;
  reason: string;
}

export interface DeidReport {
  studyInstanceUID?: string;
  status: DeidStatus;
  findings: DeidFinding[];
  scrubbedAt?: string;
}

/** Common DICOM PHI / identity tags (keyword form + numeric). */
export const PHI_TAG_KEYS = [
  "PatientName",
  "PatientID",
  "PatientBirthDate",
  "PatientSex",
  "PatientAddress",
  "PatientTelephoneNumbers",
  "OtherPatientIDs",
  "OtherPatientNames",
  "EthnicGroup",
  "Occupation",
  "AdditionalPatientHistory",
  "PatientComments",
  "InstitutionName",
  "InstitutionAddress",
  "ReferringPhysicianName",
  "PerformingPhysicianName",
  "OperatorsName",
  "StationName",
] as const;

/**
 * Remove known PHI keys from a plain tag map (e.g. Orthanc MainDicomTags).
 * Returns a new object; never invents replacement IDs beyond clearing.
 */
export function scrubDicomTags(
  tags: Record<string, unknown>
): { scrubbed: Record<string, unknown>; removed: string[] } {
  const scrubbed: Record<string, unknown> = { ...tags };
  const removed: string[] = [];
  for (const key of PHI_TAG_KEYS) {
    if (key in scrubbed && scrubbed[key] != null && scrubbed[key] !== "") {
      delete scrubbed[key];
      removed.push(key);
    }
  }
  // Numeric tag forms sometimes used in raw dumps
  for (const num of ["00100010", "00100020", "00100030", "00080080", "00080090"]) {
    if (num in scrubbed) {
      delete scrubbed[num];
      removed.push(num);
    }
  }
  return { scrubbed, removed };
}

/** Pass only when no residual PHI keys remain in the tag map. */
export function evaluateDeid(
  tags: Record<string, unknown>,
  studyInstanceUID?: string
): DeidReport {
  const residual: DeidFinding[] = [];
  for (const key of PHI_TAG_KEYS) {
    const v = tags[key];
    if (v != null && String(v).trim() !== "") {
      residual.push({ tag: key, reason: "Identity / PHI tag still present" });
    }
  }
  return {
    studyInstanceUID,
    status: residual.length === 0 ? "pass" : "fail",
    findings: residual,
    scrubbedAt: new Date().toISOString(),
  };
}

export function deidAllowsPublish(report: DeidReport | null | undefined): boolean {
  return report?.status === "pass";
}
