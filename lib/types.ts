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
 * One concrete landing of a finding on pixels. A single logical Finding can
 * have several anchors (axial + coronal, or current CT + prior MRI). The
 * student tutor drives the matching series/slice and points the laser at
 * `marker`. Side-by-side compare uses `viewportRole`.
 */
export interface FindingAnchor {
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  /** Exact SOP when known (preferred over sliceIndex for prefetch). */
  sopInstanceUID?: string;
  /** 0-based stack index within the series (Cornerstone imageId index). */
  sliceIndex?: number;
  marker: Marker;
  /** Which pane in a multi-viewport layout (Phase 2). */
  viewportRole?: "primary" | "secondary" | "compare";
  /** Chronology role when the case spans studies. */
  studyRole?: "current" | "prior" | "baseline" | "followup";
}

/**
 * One continuous authoring take: the radiologist speaks once while scrolling /
 * windowing / clicking. Viewer events + voice share one clock. Gemini later
 * segments this into multiple Findings (see StructuredSessionFinding).
 */
export interface CaptureSession {
  id: string;
  durationMs: number;
  track: RecordedTrack;
  /** Durable narration URL (same seam as finding.track.audioUrl). */
  audioUrl?: string;
  /** Full session transcript (for author review + tutor grounding). */
  transcript?: string;
  createdAt: string;
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

// ============================================================================
// Record & Replay — the self-hosted (Cornerstone) model.
//
// While the teacher holds the record hotkey we capture an ORDERED, timestamped
// log of every viewer state change (scroll/window/zoom/pan/annotation/cursor)
// plus their narration audio. Replay re-applies the SAME events in the SAME
// order, locked to the audio clock — an exact retrace. No segmentation, no
// automation: record a list, replay a list.
// ============================================================================

/** A single timestamped viewer state change (`t` = ms from record start). */
export type RecordedEvent =
  | { t: number; type: "slice"; index: number }
  | { t: number; type: "voi"; ww: number; wc: number }
  | { t: number; type: "camera"; zoom: number; pan: [number, number] }
  | { t: number; type: "invert"; value: boolean }
  | { t: number; type: "cursor"; x: number; y: number } // normalized [0,1]
  // Which series the viewport showed at this moment (multi-series cases). On
  // replay the navigator + stack switch to it. Absent in older single-series
  // recordings — they simply never emit it and stay on their one series.
  | { t: number; type: "series"; seriesInstanceUID: string }
  | {
      t: number;
      type: "annotation";
      shape: MarkerShape;
      from: [number, number]; // normalized [0,1]
      to: [number, number];
    };

/** Event shape before the recorder stamps it with a timestamp. */
export type ViewerEvent =
  | { type: "slice"; index: number }
  | { type: "voi"; ww: number; wc: number }
  | { type: "camera"; zoom: number; pan: [number, number] }
  | { type: "invert"; value: boolean }
  | { type: "cursor"; x: number; y: number }
  | { type: "series"; seriesInstanceUID: string }
  | { type: "annotation"; shape: MarkerShape; from: [number, number]; to: [number, number] };

/** One finding's recorded demonstration: ordered events + narration audio. */
export interface RecordedTrack {
  durationMs: number;
  /** The starting viewer state (slice index + W/L) so replay can prime it. */
  start: { sliceIndex: number; ww?: number; wc?: number };
  events: RecordedEvent[];
  /** URL/key of the teacher's narration audio (their real voice). */
  audioUrl?: string;
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
  /** Self-hosted record/replay: ordered state-change log + narration audio. */
  track?: RecordedTrack;
  durationMs?: number;
  /** Default guided-tour sequence (search-pattern order). */
  order: number;

  // --- SaaS layer (optional; present once a finding is tied to DICOM) -------
  /** Which study/series this finding is anchored to (drives prefetch). */
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  /** Ordered SOP Instance UIDs this finding's flow walks through (prefetch). */
  sopInstanceUIDs?: string[];
  /** Exact SOP for the primary landing (when known). */
  sopInstanceUID?: string;
  /** 0-based slice index for the primary landing. */
  sliceIndex?: number;
  /**
   * All landings for this finding (multi-series / multi-study). When absent,
   * the primary marker + seriesInstanceUID fields above are the sole anchor.
   */
  anchors?: FindingAnchor[];
  /** Continuous-capture provenance (session id + time range on the take). */
  captureSessionId?: string;
  tStartMs?: number;
  tEndMs?: number;
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

  // --- Library taxonomy (optional; back-compat — older seed cases omit these) -
  /** Learner-facing difficulty tier for the catalog. */
  difficulty?: Difficulty;
  /** Anatomical / body-system taxonomy for filtering the catalog. */
  system?: BodySystem;
  /** Free-form teaching tags (e.g. "fracture", "PE", "incidentaloma"). */
  tags?: string[];
  /** The Author who authored this case (attribution in the catalog). */
  authorId?: string;

  // --- Exam-grade teaching details (optional; back-compat) ------------------
  // A radiology educator (FRCR/RANZCR/ACR) authors a case the way they teach it:
  // a clinical stem, the diagnosis + a ranked differential, pedagogy (level +
  // objectives) and a discussion with references. All optional so older seed
  // cases keep validating (the `normalizeCase` discipline, §6).

  /** Presenting clinical history / stem shown before the read. */
  clinicalHistory?: string;
  /** Patient age as a teaching label (e.g. "54", "6 months") — non-PHI. */
  patientAge?: string;
  /** Patient sex (canonical PATIENT_SEXES). */
  patientSex?: PatientSex;
  /** Imaging technique / protocol / sequence (e.g. "Portal-venous CT abdomen"). */
  technique?: string;
  /** The teaching diagnosis (the "answer"). */
  primaryDiagnosis?: string;
  /** Ranked differential diagnoses (most → least likely). */
  differentials?: string[];
  /** Intended learner level (canonical TARGET_LEVELS). */
  targetLevel?: TargetLevel;
  /** What the learner should be able to do after this case. */
  learningObjectives?: string[];
  /** Long-form teaching discussion (pathophysiology, pitfalls, management). */
  discussion?: string;
  /** Citations / further reading (free-form lines or URLs). */
  references?: string[];

  /**
   * Continuous authoring takes for this case (optional). Findings may point
   * back via `captureSessionId` + `tStartMs`/`tEndMs`.
   */
  captureSessions?: CaptureSession[];

  createdAt?: string;
  updatedAt?: string;
}

/** Strict shape returned by the Gemini authoring call (text fields only). */
export interface StructuredFinding {
  label: string;
  description: string;
  teachingPoints: string[];
}

/**
 * One finding carved out of a continuous capture session. Includes the time
 * range on the session clock so we can slice the recorded track / audio later.
 */
export interface StructuredSessionFinding extends StructuredFinding {
  /** ms from session start — inclusive. */
  tStartMs: number;
  /** ms from session start — exclusive/end. */
  tEndMs: number;
  /** Suggested marker from nearest cursor sample in-range (may be absent). */
  suggestedMarker?: Marker;
  suggestedSliceIndex?: number;
}

/** Full continuous-session structure response. */
export interface StructuredSession {
  transcript: string;
  findings: StructuredSessionFinding[];
}

// ============================================================================
// SaaS entity hierarchy (CLAUDE.md §4a):  Org → Patient → Study → Case → Finding
//
// All of these are persisted via lib/cases.ts and scoped by `orgId`. Auth is a
// seam now (single demo org), but every entity carries its tenant so we never
// have to refactor when real auth lands.
// ============================================================================

export type UserRole = "admin" | "author" | "student";

/** Platform-wide role (above any org). Super-admin only. */
export type PlatformRole = "super_admin";

/** Per-org membership role (ARCHITECTURE § identity). */
export type MembershipRole = "owner" | "admin" | "author" | "student";

export type CaseStatus = "draft" | "published";

// ----------------------------------------------------------------------------
// Library taxonomy (CLAUDE.md §2 — the catalog turns a pile of cases into a
// teaching LIBRARY). Difficulty + body system drive the filterable catalog.
// ----------------------------------------------------------------------------

export type Difficulty = "beginner" | "intermediate" | "advanced";

/** Patient sex as a non-PHI teaching label. */
export type PatientSex = "M" | "F" | "other" | "unknown";

/**
 * Intended learner level for a case. Training-grade tiers a radiology educator
 * actually uses: R1–R3 (US residency years), `registrar` (UK/AUS/NZ), `fellow`
 * (subspecialty), and `CME` (practising-attending continuing education).
 */
export type TargetLevel = "R1" | "R2" | "R3" | "registrar" | "fellow" | "CME";

/** Body-system taxonomy used to organise and filter the catalog. */
export type BodySystem =
  | "Neuro"
  | "MSK"
  | "Chest"
  | "Cardiac"
  | "Abdominal"
  | "GU"
  | "Head & Neck"
  | "Paediatric"
  | "Vascular";

/** Canonical ordered lists — the single source of truth for UI + validation. */
export const DIFFICULTIES: Difficulty[] = ["beginner", "intermediate", "advanced"];

export const PATIENT_SEXES: PatientSex[] = ["M", "F", "other", "unknown"];

export const TARGET_LEVELS: TargetLevel[] = [
  "R1",
  "R2",
  "R3",
  "registrar",
  "fellow",
  "CME",
];

export const BODY_SYSTEMS: BodySystem[] = [
  "Neuro",
  "MSK",
  "Chest",
  "Cardiac",
  "Abdominal",
  "GU",
  "Head & Neck",
  "Paediatric",
  "Vascular",
];

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
  /** @deprecated Prefer Membership.role + platformRole. Kept for seed back-compat. */
  role: UserRole;
  /** Platform staff — not scoped to a single org. */
  platformRole?: PlatformRole;
  /** Better Auth / Google subject id when linked. */
  authProviderId?: string;
  image?: string;
  createdAt: string;
}

/**
 * Per-org membership — source of truth for RBAC.
 * A request is authorized iff the session user holds a Membership in the
 * resource's orgId with a sufficient role (or is platform super_admin).
 */
export interface Membership {
  id: string;
  userId: string;
  orgId: string;
  role: MembershipRole;
  status?: "active" | "invited" | "revoked";
  invitedBy?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Verified teacher profile tied to a User (marketplace face).
 * Extends attribution-only Author; same id space when migrated.
 */
export interface AuthorProfile {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  avatarUrl?: string;
  bio?: string;
  institution?: string;
  credentials?: string;
  subspecialties?: BodySystem[];
  socials?: { website?: string; twitter?: string; linkedin?: string };
  verification: "unverified" | "pending" | "verified" | "rejected";
  createdAt: string;
  updatedAt: string;
}

/** Student enrollment in a course (marketplace entitlement). */
export interface Enrollment {
  id: string;
  userId: string;
  orgId: string;
  courseId: string;
  source: "free" | "purchase" | "seat" | "subscription";
  status: "active" | "canceled" | "expired";
  createdAt: string;
  updatedAt: string;
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

// ============================================================================
// Library entities (CLAUDE.md §2):  Author · Course · Playlist
//
// These turn the flat case list into a real teaching LIBRARY. They are org-
// scoped like Patient/Study and persist through the SAME store seam in
// lib/cases.ts, so they work on JSON-on-volume today and MongoDB later.
// ============================================================================

/**
 * A teacher/contributor credited on cases and courses. Attribution only until
 * linked: optional `userId` migrates this row toward AuthorProfile (same id).
 */
export interface Author {
  id: string;
  orgId: string;
  name: string;
  /** Optional avatar image URL (falls back to initials in the UI). */
  avatarUrl?: string;
  /** Short teaching bio shown on the author profile page. */
  bio?: string;
  /** Institution / department affiliation. */
  institution?: string;
  /** Professional credentials shown next to the name, e.g. "MD, FRCR". */
  credentials?: string;
  /** Subspecialty tags (reuses the body-system taxonomy). */
  subspecialties?: BodySystem[];
  /** Optional social / professional links. */
  socials?: { website?: string; twitter?: string; linkedin?: string };
  /** Authenticated user this public face belongs to (AuthorProfile join). */
  userId?: string;
  /** Verification gate for public publishing. Absent = unverified attribution. */
  verification?: AuthorProfile["verification"];
  createdAt: string;
  updatedAt: string;
}

/**
 * A curated, ordered teaching unit grouping multiple cases (e.g. "Chest CT
 * Essentials"). Has its own difficulty/system taxonomy and an author.
 */
export interface Course {
  id: string;
  orgId: string;
  title: string;
  description?: string;
  difficulty?: Difficulty;
  system?: BodySystem;
  authorId?: string;
  /** Ordered case IDs that make up the course. */
  caseIds: string[];
  status: CaseStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * A lightweight, ordered list of cases (Spotify-style). Unlike a Course it has
 * no taxonomy/author — it's a simple curated rail ("Continue", "By system").
 */
export interface Playlist {
  id: string;
  orgId: string;
  title: string;
  description?: string;
  /** Ordered case IDs in the playlist. */
  caseIds: string[];
  createdAt: string;
  updatedAt: string;
}
