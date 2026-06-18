// Shared client-side types for the admin console. These mirror the API route
// response shapes (app/api/admin/**) so the client stays in lockstep without
// importing lib/cases (the data layer is server-only — §3).

import type {
  Author,
  BodySystem,
  Case,
  CaseStatus,
  CaseStudyRef,
  Course,
  Difficulty,
  Patient,
  Playlist,
  Study,
} from "@/lib/types";

export type {
  Author,
  BodySystem,
  Case,
  CaseStatus,
  CaseStudyRef,
  Course,
  Difficulty,
  Patient,
  Playlist,
  Study,
};

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
  studyDescription: string;
  seriesDescription?: string;
  modality?: string;
  studyDate?: string;
  /** Internal Orthanc handle for the parent study (server-only truth). */
  orthancStudyId?: string;
  /** First SOP Instance UID in the series — enough for a cover thumbnail. */
  firstInstanceUID?: string;
  instances: number;
}

/** A file that was rejected or failed to store, with a human-readable reason. */
export interface SkippedFile {
  name: string;
  reason: string;
}

/** Result of uploading one batch of files (one POST /api/upload call). */
export interface UploadResult {
  stored: number;
  series: UploadedSeries[];
  /** Files that reached the server but failed to store, with reasons. */
  failed: SkippedFile[];
  /** Files the server recognized as non-DICOM / junk and ignored. */
  skipped: SkippedFile[];
}

/** Raised by uploadDicom when the imaging archive isn't configured (HTTP 503). */
export class OrthancUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrthancUnavailableError";
  }
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

// Re-export the canonical taxonomy lists (from lib/types) so the modals have a
// single source of truth for the difficulty / body-system pickers.
export { DIFFICULTIES, BODY_SYSTEMS } from "@/lib/types";
