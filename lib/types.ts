// Core data model for FlowRad Learn — aligned to the REAL Pacsbin 2.0 viewer.
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
}

export interface CaseData {
  caseId: string;
  title: string;
  modality: string;
  /** Base Pacsbin viewer URL, e.g. https://pacsbin.com/viewer/case/<shortId>. */
  pacsbinBaseUrl: string;
  findings: Finding[];
}

/** Strict shape returned by the Gemini authoring call (text fields only). */
export interface StructuredFinding {
  label: string;
  description: string;
  teachingPoints: string[];
}
