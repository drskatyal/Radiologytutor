// Core data model for FlowRad Learn.
// NOTE: series/image are ALWAYS stored as string IDs (integers break when
// series are reordered or images are deleted). Markers are stored as
// percentages of the overlay box so they remap onto the same anatomy once we
// lock the same viewport state at playback time.

export type MarkerShape = "circle" | "arrow";

export interface Viewport {
  /** Pacsbin layout, e.g. "1x1" or "2x1". */
  layout: string;
  /** Series id (string) for viewport 1. */
  s1: string;
  /** Image/slice id (string) for viewport 1. */
  i1: string;
  /** Window width for viewport 1. */
  ww1?: number;
  /** Window center for viewport 1. */
  wc1?: number;
  /** Zoom factor for viewport 1. */
  scale1?: number;
  /** Pan for viewport 1 as "x,y" floats in pixels. */
  translation1?: string;

  // Optional second viewport, used for compare (2x1) layouts.
  s2?: string;
  i2?: string;
  ww2?: number;
  wc2?: number;
  scale2?: number;
  translation2?: string;
}

export interface Marker {
  /** clickX / overlayWidth, in [0,1]. */
  x_pct: number;
  /** clickY / overlayHeight, in [0,1]. */
  y_pct: number;
  shape: MarkerShape;
}

export interface Finding {
  id: string;
  label: string;
  description: string;
  teachingPoints: string[];
  viewport: Viewport;
  marker: Marker;
  /** Default guided-tour sequence (search-pattern order). */
  order: number;
}

export interface CaseData {
  caseId: string;
  title: string;
  modality: string;
  /** Base Pacsbin viewer URL, e.g. https://pacsbin.com/viewer/<token>. */
  pacsbinBaseUrl: string;
  findings: Finding[];
}

/** Strict shape returned by the Gemini authoring call (text fields only). */
export interface StructuredFinding {
  label: string;
  description: string;
  teachingPoints: string[];
}
