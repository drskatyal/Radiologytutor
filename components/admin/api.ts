// Thin fetch wrappers around the admin API routes. The client talks only to
// these HTTP endpoints — it never imports the lib/cases data layer (§3).

import type {
  AdminCaseRow,
  Case,
  CaseStatus,
  CaseStudyRef,
  Patient,
  SeriesMeta,
  Study,
  UploadResult,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function fetchCases(): Promise<AdminCaseRow[]> {
  const res = await fetch("/api/admin/cases", { cache: "no-store" });
  return (await json<{ cases: AdminCaseRow[] }>(res)).cases;
}

export async function fetchPatients(): Promise<Patient[]> {
  const res = await fetch("/api/admin/patients", { cache: "no-store" });
  return (await json<{ patients: Patient[] }>(res)).patients;
}

export interface CreateCaseStudyInput {
  studyInstanceUID: string;
  seriesInstanceUIDs?: string[];
  description?: string;
  modality?: string;
  caseSeriesInstanceUIDs?: string[];
  role?: CaseStudyRef["role"];
}

export interface CreateCaseInput {
  title: string;
  modality: string;
  specialty?: string;
  status?: CaseStatus;
  patientId?: string;
  patientName?: string;
  studies?: CreateCaseStudyInput[];
}

export async function createCase(input: CreateCaseInput): Promise<Case> {
  const res = await fetch("/api/admin/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await json<{ case: Case }>(res)).case;
}

export interface UpdateCaseInput {
  title?: string;
  modality?: string;
  specialty?: string | null;
  status?: CaseStatus;
  studyRefs?: CaseStudyRef[];
}

export async function updateCase(
  caseId: string,
  patch: UpdateCaseInput
): Promise<Case> {
  const res = await fetch(`/api/admin/cases/${encodeURIComponent(caseId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await json<{ case: Case }>(res)).case;
}

export async function deleteCase(caseId: string): Promise<void> {
  const res = await fetch(`/api/admin/cases/${encodeURIComponent(caseId)}`, {
    method: "DELETE",
  });
  await json<{ ok: true }>(res);
}

export async function fetchCaseDetail(caseId: string): Promise<{
  case: Case;
  patient: Patient | null;
  studies: Study[];
}> {
  const res = await fetch(`/api/admin/cases/${encodeURIComponent(caseId)}`, {
    cache: "no-store",
  });
  return json(res);
}

export async function fetchStudySeries(studyId: string): Promise<{
  study: Study;
  series: SeriesMeta[];
  hasImaging: boolean;
}> {
  const res = await fetch(
    `/api/admin/studies/${encodeURIComponent(studyId)}/series`,
    { cache: "no-store" }
  );
  return json(res);
}

/** Upload DICOM files to Orthanc; returns the resulting study/series UIDs. */
export async function uploadDicom(files: FileList | File[]): Promise<UploadResult> {
  const form = new FormData();
  Array.from(files).forEach((f) => form.append("files", f));
  const res = await fetch("/api/upload", { method: "POST", body: form });
  return json<UploadResult>(res);
}
