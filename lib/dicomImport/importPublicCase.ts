// Import a curated public teaching case: download TCIA DICOM (when needed),
// ingest to Orthanc, persist patient/study/case + findings for student learning.

import {
  createCaseForOrg,
  createFinding,
  createPatient,
  createStudy,
  deleteFindingScoped,
  getCaseForOrg,
  getDeidReport,
  getPatient,
  getStudyByUID,
  updateCaseForOrg,
  upsertDeidReport,
} from "@/lib/cases";
import { downloadTciaSeriesDicom } from "@/lib/dicomImport/tcia";
import { getPublicCaseTemplate } from "@/lib/publicCases/catalog";
import {
  orthancAuthHeader,
  orthancBase,
  orthancConfigured,
  orthancFindSeriesByUID,
  orthancFindStudyByUID,
  orthancGet,
  orthancIngestInstance,
  orthancSeriesInstances,
} from "@/lib/orthanc";
import { deidAllowsPublish, inspectDicomBytes } from "@/lib/deid";
import type { Case, Finding } from "@/lib/types";
import { DEFAULT_ORG_ID } from "@/lib/cases";

export interface ImportPublicCaseResult {
  caseId: string;
  created: boolean;
  ingestedInstances: number;
  skippedInstances: number;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  instanceCount: number;
  case: Case;
}

export interface ImportPublicCaseOptions {
  orgId?: string;
  /** Re-download and re-ingest even if study already in Orthanc. */
  force?: boolean;
  /** Publish after import (requires passing de-id). */
  publish?: boolean;
}

function genFindingId(caseId: string, order: number): string {
  return `f_${caseId.replace(/-/g, "").slice(0, 10)}_${order}`;
}

/** Scale finding slice indices to the imported stack height. */
function scaleFindingSlices(
  findings: Omit<Finding, "id">[],
  instanceCount: number
): Omit<Finding, "id">[] {
  if (instanceCount <= 1) return findings;
  const templateMax = Math.max(...findings.map((f) => f.sliceIndex ?? 0), 1);
  return findings.map((f) => {
    const t = f.sliceIndex ?? 0;
    const scaled = Math.round((t / templateMax) * (instanceCount - 1));
    return { ...f, sliceIndex: Math.max(0, Math.min(instanceCount - 1, scaled)) };
  });
}

async function ensureDeidReportForStudy(
  orgId: string,
  studyUID: string,
  seriesUID: string
): Promise<void> {
  const existing = await getDeidReport(studyUID);
  if (existing && deidAllowsPublish(existing)) return;

  const seriesId = await orthancFindSeriesByUID(seriesUID);
  if (!seriesId) return;
  const series = await orthancGet<{ Instances: string[] }>(`/series/${seriesId}`);
  const instId = series.Instances[0];
  if (!instId) return;

  const fileRes = await fetch(`${orthancBase()}/instances/${instId}/file`, {
    headers: { Authorization: orthancAuthHeader() },
  });
  if (!fileRes.ok) return;
  const bytes = await fileRes.arrayBuffer();
  const report = inspectDicomBytes(bytes);
  report.studyInstanceUID = studyUID;
  if (deidAllowsPublish(report)) {
    await upsertDeidReport(orgId, { ...report, studyInstanceUID: studyUID });
  }
}

async function ensureStudyInOrthanc(
  template: NonNullable<ReturnType<typeof getPublicCaseTemplate>>,
  force: boolean
): Promise<{ instanceCount: number; orthancStudyId: string | null; ingested: number; skipped: number }> {
  const { source } = template;
  const studyUID = source.studyInstanceUID;
  const seriesUID = source.seriesInstanceUID;

  const existingStudyId = await orthancFindStudyByUID(studyUID);
  if (existingStudyId && !force) {
    const seriesId = await orthancFindSeriesByUID(seriesUID);
    if (seriesId) {
      const instances = await orthancSeriesInstances(seriesId);
      return {
        instanceCount: instances.length,
        orthancStudyId: existingStudyId,
        ingested: 0,
        skipped: 0,
      };
    }
  }

  if (source.kind === "orthanc_existing") {
    throw new Error(
      `Study ${studyUID} not found in Orthanc — upload the BBMRI MEMPRAGE series first.`
    );
  }

  const buffers = await downloadTciaSeriesDicom(seriesUID);
  let ingested = 0;
  let skipped = 0;

  for (const bytes of buffers) {
    try {
      const res = await orthancIngestInstance(bytes);
      ingested++;
      if (res.deidReport?.studyInstanceUID) {
        await upsertDeidReport(DEFAULT_ORG_ID, {
          ...res.deidReport,
          studyInstanceUID: res.deidReport.studyInstanceUID ?? studyUID,
        });
      }
    } catch {
      skipped++;
    }
  }

  if (ingested === 0) {
    throw new Error(
      `Failed to ingest any instances for ${seriesUID} (${skipped} skipped)`
    );
  }

  const orthancStudyId = (await orthancFindStudyByUID(studyUID)) ?? null;
  const seriesId = await orthancFindSeriesByUID(seriesUID);
  const instanceCount = seriesId
    ? (await orthancSeriesInstances(seriesId)).length
    : ingested;

  return { instanceCount, orthancStudyId, ingested, skipped };
}

async function upsertCaseRecords(
  orgId: string,
  template: NonNullable<ReturnType<typeof getPublicCaseTemplate>>,
  orthancStudyId: string | null,
  instanceCount: number,
  publish: boolean
): Promise<{ caseData: Case; created: boolean }> {
  const patientId = template.patientId ?? `pat_${template.caseId.replace(/^case-/, "")}`;
  const studyId = template.studyId ?? `stu_${template.caseId.replace(/^case-/, "")}`;

  if (!(await getPatient(orgId, patientId))) {
    await createPatient(orgId, { id: patientId, displayName: template.patientDisplayName });
  }

  if (!(await getStudyByUID(orgId, template.source.studyInstanceUID))) {
    await createStudy(orgId, {
      id: studyId,
      patientId,
      studyInstanceUID: template.source.studyInstanceUID,
      modality: template.modality,
      description: template.technique,
      orthancStudyId: orthancStudyId ?? undefined,
      seriesInstanceUIDs: [template.source.seriesInstanceUID],
    });
  }

  const existing = await getCaseForOrg(orgId, template.caseId);
  let created = false;
  const scaledFindings = scaleFindingSlices(template.findings, instanceCount);

  const casePatch = {
    title: template.title,
    modality: template.modality,
    specialty: template.specialty,
    difficulty: template.difficulty,
    system: template.system,
    tags: template.tags,
    clinicalHistory: template.clinicalHistory,
    technique: template.technique,
    primaryDiagnosis: template.primaryDiagnosis,
    differentials: template.differentials,
    targetLevel: template.targetLevel,
    learningObjectives: template.learningObjectives,
    discussion: template.discussion,
    references: template.references,
    pacsbinBaseUrl: "/cornerstone",
    studyRefs: [
      {
        studyInstanceUID: template.source.studyInstanceUID,
        seriesInstanceUIDs: [template.source.seriesInstanceUID],
        role: "current" as const,
        order: 0,
      },
    ],
    status: (publish ? "published" : "draft") as Case["status"],
  };

  if (existing) {
    await updateCaseForOrg(orgId, template.caseId, casePatch);
    for (const f of existing.findings) {
      await deleteFindingScoped(orgId, template.caseId, f.id);
    }
  } else {
    created = true;
    await createCaseForOrg(orgId, {
      caseId: template.caseId,
      ...casePatch,
      patientId,
      authorId: "auth_demo",
    });
  }

  for (const f of scaledFindings) {
    const finding: Finding = {
      ...f,
      id: genFindingId(template.caseId, f.order ?? 1),
    };
    await createFinding(orgId, template.caseId, finding);
  }

  const refreshed = await getCaseForOrg(orgId, template.caseId);
  if (!refreshed) throw new Error(`Case ${template.caseId} missing after import`);
  return { caseData: refreshed, created };
}

/** Import one catalog case end-to-end. */
export async function importPublicCase(
  caseId: string,
  options: ImportPublicCaseOptions = {}
): Promise<ImportPublicCaseResult> {
  if (!orthancConfigured()) {
    throw new Error("ORTHANC_URL is not configured — cannot import real DICOM cases.");
  }

  const template = getPublicCaseTemplate(caseId);
  if (!template) {
    throw new Error(`Unknown public case template: ${caseId}`);
  }

  const orgId = options.orgId ?? DEFAULT_ORG_ID;
  const { instanceCount, orthancStudyId, ingested, skipped } = await ensureStudyInOrthanc(
    template,
    options.force ?? false
  );

  await ensureDeidReportForStudy(
    orgId,
    template.source.studyInstanceUID,
    template.source.seriesInstanceUID
  );

  const { caseData, created } = await upsertCaseRecords(
    orgId,
    template,
    orthancStudyId,
    instanceCount,
    options.publish ?? true
  );

  return {
    caseId: template.caseId,
    created,
    ingestedInstances: ingested,
    skippedInstances: skipped,
    studyInstanceUID: template.source.studyInstanceUID,
    seriesInstanceUID: template.source.seriesInstanceUID,
    instanceCount,
    case: caseData,
  };
}

/** Import every catalog entry (skips failures, returns per-case results). */
export async function importAllPublicCases(
  options: ImportPublicCaseOptions = {}
): Promise<{ ok: ImportPublicCaseResult[]; failed: { caseId: string; error: string }[] }> {
  const { listPublicCaseTemplates } = await import("@/lib/publicCases/catalog");
  const ok: ImportPublicCaseResult[] = [];
  const failed: { caseId: string; error: string }[] = [];

  for (const t of listPublicCaseTemplates()) {
    try {
      ok.push(await importPublicCase(t.caseId, options));
    } catch (err) {
      failed.push({
        caseId: t.caseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok, failed };
}
