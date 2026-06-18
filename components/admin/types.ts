// Shared client-side types for the admin console. These mirror the API route
// response shapes (app/api/admin/**) so the client stays in lockstep without
// importing lib/cases (the data layer is server-only — §3).

import type { Case, CaseStatus, CaseStudyRef, Patient, Study } from "@/lib/types";

export type { Case, CaseStatus, CaseStudyRef, Patient, Study };

/** A case row enriched for the admin list (matches AdminCaseRow on the server). */
export interface AdminCaseRow extends Case {
  patientName?: string;
  studyCount: number;
  findingCount: number;
}

/** One series of an uploaded study, as returned by POST /api/upload. */
export interface UploadedSeries {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  description: string;
  instances: number;
}

export interface UploadResult {
  stored: number;
  series: UploadedSeries[];
  errors: string[];
}

/** Compact series metadata (mirrors SeriesMeta from lib/orthanc). */
export interface SeriesMeta {
  seriesInstanceUID: string;
  orthancSeriesId: string;
  modality?: string;
  seriesDescription?: string;
  seriesNumber?: number;
  instanceCount: number;
  firstInstanceUID?: string;
}

export type StudyRole = NonNullable<CaseStudyRef["role"]>;

export const STUDY_ROLES: StudyRole[] = ["current", "prior", "comparison"];

export const MODALITIES = ["CT", "MR", "XR", "US", "CR", "DX", "MG", "PT", "NM"];

export const SPECIALTIES = [
  "Neuroradiology",
  "Chest",
  "Abdominal",
  "Musculoskeletal",
  "Breast",
  "Cardiac",
  "Pediatric",
  "Emergency",
  "Nuclear medicine",
  "Interventional",
];
