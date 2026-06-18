// Core data model for FlowRad Learn.
//
// Two layers coexist here:
//
//  1. The VIEWER-STATE layer (Pacsbin 2.0 encoded `state` blobs, keyframes,
//     normalized markers). This is what the student/author UI and the playback
//     driver consume today and MUST stay stable.
//
//  2. The SaaS DATA layer (Org → Patient → Study → Series → Case → Finding),
//     per CLAUDE.md §4a. Everything is scoped by `orgId` (multi-tenant). DICOM
//     identity is always UIDs; Orthanc ids are internal only.
//
// Pacsbin 2.0 (Vue + Cornerstone3D) encodes the whole viewer as ONE object
// serialized into the `state` query param as gzip(JSON) -> base64url. We can't
// read it back out of the cross-origin iframe, so the tutor pastes a Pacsbin
// URL and we keep its `state` blob verbatim (lossless, no re-encoding needed to
// replay). We decode it server-side only when the AI needs to know what's shown.

export type MarkerShape = "circle" | "arrow";

/** One viewport tile inside Pacsbin's decoded state (for inspection / AI).
 * Covers both "stack" (2D slice) and "volume" (MPR/3D) viewports. */
export interface PacsbinViewport {
  type: string; // "stack" | "volume"
  studyId?: string;
  seriesId?: string;
  instanceId?: string; // displayed slice (stack viewports only)
  focalPoint?: number[];
  viewUp?: number[];
  viewPlaneNormal?: number[];
  ww?: number;
  wc?: number;
  zoom?: number;
  pan?: number[];
  invert?: boolean;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  // Volume / MPR viewports:
  slabThickness?: number;
  blendMode?: number; // 0 composite, MIP/MinIP/Average etc.
}

/** Pacsbin 2.0 decoded viewer state. */
export interface ViewerState {
  viewMode: string; // "grid" | "crosshairs" | "volume"
  layout: number[]; // [rows, cols]
  viewports: PacsbinViewport[];
}

export interface Marker {
  /** clickX / overlayWidth, in [0,1]. */
  x_pct: number;
  /** clickY / overlayHeight, in [0,1]. */
  y_pct: number;
  shape: MarkerShape;
}

/**
 * One recorded moment in a finding's dynamic flow. `state` is Pacsbin's
 * encoded `state` blob captured at that moment; `t` is ms from the start of
 * the recording. Because setting `state` reloads the cross-origin iframe,
 * playback SNAPS between keyframes (smooth in-iframe scrubbing isn't possible
 * with Pacsbin; that needs a self-hosted Cornerstone3D viewer later).
 */
export interface Keyframe {
  t: number;
  state: string;
  marker?: Marker;
}

export interface Finding {
  id: string;
  label: string;
  description: string;
  teachingPoints: string[];
  /** Pacsbin encoded `state` for the primary/poster view (first keyframe). */
  state: string;
  marker: Marker;
  /** Recorded dynamic flow (snap between these). Absent for a single view. */
  keyframes?: Keyframe[];
  durationMs?: number;
  /** Default guided-tour sequence (search-pattern order). */
  order: number;

  // --- SaaS layer (optional; present once a finding is tied to DICOM) -------
  /** Which study/series this finding is anchored to (drives prefetch). */
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  /** Ordered SOP Instance UIDs this finding's flow walks through (prefetch). */
  sopInstanceUIDs?: string[];
}

export interface CaseData {
  caseId: string;
  title: string;
  modality: string;
  /** Base Pacsbin viewer URL, e.g. https://pacsbin.com/viewer/case/<shortId>. */
  pacsbinBaseUrl: string;
  findings: Finding[];

  // --- SaaS layer (optional; back-compat — older seed cases omit these) -----
  /** Tenant that owns this case. Defaults to DEFAULT_ORG_ID when absent. */
  orgId?: string;
  /** Patient whose studies this case teaches from (chronology/comparison). */
  patientId?: string;
  status?: CaseStatus;
  specialty?: string;
  /** Studies/series this case draws on — supports prior vs current. */
  studyRefs?: CaseStudyRef[];
  createdAt?: string;
  updatedAt?: string;
}

/** Strict shape returned by the Gemini authoring call (text fields only). */
export interface StructuredFinding {
  label: string;
  description: string;
  teachingPoints: string[];
}

// ============================================================================
// SaaS entity hierarchy (CLAUDE.md §4a):  Org → Patient → Study → Case → Finding
//
// All of these are persisted via lib/cases.ts and scoped by `orgId`. Auth is a
// seam now (single demo org), but every entity carries its tenant so we never
// have to refactor when real auth lands.
// ============================================================================

export type UserRole = "admin" | "author" | "student";
export type CaseStatus = "draft" | "published";

/** A tenant. All cases/patients/studies belong to exactly one org. */
export interface Org {
  id: string;
  name: string;
  createdAt: string;
}

/** A member of an org with a role. (Auth is stubbed; this is the shape.) */
export interface User {
  id: string;
  orgId: string;
  email: string;
  name?: string;
  role: UserRole;
  createdAt: string;
}

/**
 * Groups multiple Studies for chronology/comparison (prior vs current).
 * `displayName` is a teaching label — NOT PHI; real patient identity stays in
 * the (de-identified) DICOM. De-identification is deferred (CLAUDE.md §4a).
 */
export interface Patient {
  id: string;
  orgId: string;
  /** Teaching-facing label, e.g. "Case A — 54M" (no PHI). */
  displayName: string;
  /** Stable pseudonymous key used to dedupe studies across uploads. */
  mrnHash?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A DICOM study belonging to a patient. Carries `studyDate` so the UI can order
 * studies chronologically and show "prior vs current". DICOM identity is the
 * StudyInstanceUID; `orthancStudyId` is an internal handle, never shown.
 */
export interface Study {
  id: string;
  orgId: string;
  patientId: string;
  studyInstanceUID: string;
  /** DICOM DA "YYYYMMDD" or ISO date — store as-is, sort lexicographically. */
  studyDate?: string;
  modality?: string;
  description?: string;
  /** Internal Orthanc handle (server-only; not exposed to clients as truth). */
  orthancStudyId?: string;
  /** SeriesInstanceUIDs in this study (ordered as Orthanc returns them). */
  seriesInstanceUIDs: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A reference from a Case to a specific study (and optionally specific series)
 * of its patient. A case may hold several of these to compare prior vs current.
 */
export interface CaseStudyRef {
  studyInstanceUID: string;
  /** Subset of the study's series this case actually uses (empty = all). */
  seriesInstanceUIDs?: string[];
  /** Author-facing role of this study within the case. */
  role?: "current" | "prior" | "comparison";
  /** Lower = earlier; mirrors chronological order for convenience. */
  order?: number;
}

/**
 * The SaaS-shaped Case record. This is a SUPERSET of CaseData: it keeps every
 * field the viewer/author/playback code already reads (`pacsbinBaseUrl`,
 * `findings`, `title`, `modality`) and adds tenant + DICOM linkage. Persisting
 * a `Case` and reading it back as `CaseData` is therefore lossless.
 */
export interface Case extends CaseData {
  orgId: string;
  patientId?: string;
  status: CaseStatus;
  specialty?: string;
  studyRefs?: CaseStudyRef[];
  createdAt: string;
  updatedAt: string;
}
