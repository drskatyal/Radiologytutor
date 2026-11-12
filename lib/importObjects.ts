/** Private import snapshots/receipts; Mongo remains the authoritative case store. */
import { randomUUID } from "node:crypto";
import { assertNoPhi } from "./phiGuard";
import { assertDurableStorageConfigured } from "./envSchema";
import { objectStorageConfigured, putObject } from "./objectStorage";
import type { CaseData } from "./types";

async function persist(key: string, value: unknown): Promise<void> {
  assertDurableStorageConfigured();
  assertNoPhi(value);
  if (!objectStorageConfigured()) return; // existing local development mode
  const result = await putObject(key, Buffer.from(JSON.stringify(value)), "application/json");
  if (!result) throw new Error("Import object was not stored.");
}

export async function persistImportedCase(orgId: string, data: CaseData): Promise<void> {
  // Case.patientId is the internal database relationship, not DICOM PatientID.
  // It is deliberately omitted, not exported or used as a storage key.
  const { patientId: _patientReference, ...content } = data;
  assertNoPhi(content);
  // Build an allowlist. No patient identity, share capability or approval grants.
  const snapshot = {
    schema: 1, kind: "import_snapshot", caseId: data.caseId, title: data.title,
    modality: data.modality,
    findings: data.findings.map(f => ({
      id: f.id, label: f.label, description: f.description, teachingPoints: f.teachingPoints,
      studyInstanceUID: f.studyInstanceUID, seriesInstanceUID: f.seriesInstanceUID,
      sopInstanceUID: f.sopInstanceUID, frameNumber: f.frameNumber, anchor: f.anchor,
    })),
  };
  await persist(`cases/${encodeURIComponent(orgId)}/${encodeURIComponent(data.caseId)}/import.json`, snapshot);
}

export async function persistUploadReceipt(orgId: string, series: Array<{
  studyInstanceUID: string; seriesInstanceUID: string; firstInstanceUID?: string; instances: number;
}>, counts: { stored: number; duplicates: number }): Promise<void> {
  await persist(`imports/${encodeURIComponent(orgId)}/${randomUUID()}.json`, {
    schema: 1, kind: "upload_receipt", stored: counts.stored, duplicates: counts.duplicates,
    series: series.map(s => ({ studyInstanceUID: s.studyInstanceUID, seriesInstanceUID: s.seriesInstanceUID, firstInstanceUID: s.firstInstanceUID, instances: s.instances })),
  });
}
