// Plain viewer-source descriptors — NO Cornerstone imports, so server
// components / pages can import these constants without pulling the WebGL
// viewer (and its DOM/worker code) into the server bundle.

export type ViewerSource =
  | { kind: "wadouri"; url: string; frames: number }
  | {
      kind: "wadors";
      wadoRsRoot: string;
      StudyInstanceUID: string;
      SeriesInstanceUID: string;
    };

// Bundled open sample: pydicom's emri_small (MR, 10 frames, uncompressed),
// served from /public — no backend, no CORS. Tiny (64x64), just to prove our
// viewer renders + scrolls; real cases come via Orthanc/DICOMweb.
export const BUNDLED_CASE: ViewerSource = {
  kind: "wadouri",
  url: "/dicom/emri_small.dcm",
  frames: 10,
};

// Public DICOMweb CT (full resolution) used by the official Cornerstone
// examples — to test a real WADO-RS source.
export const PUBLIC_DEMO: ViewerSource = {
  kind: "wadors",
  wadoRsRoot: "https://d3t6nz73ql33tx.cloudfront.net/dicomweb",
  StudyInstanceUID:
    "1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463",
  SeriesInstanceUID:
    "1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561",
};

// ============================================================================
// Multi-series model — the PACS series rail.
//
// A case may draw on several series (across one or more studies). `CaseSeries`
// is a plain, server-safe descriptor (NO Cornerstone imports) so server pages
// can resolve a case's series and hand the list to BOTH the client viewer and
// the SeriesNavigator. Each entry carries enough to (a) build the viewer source
// on demand and (b) render a navigator card with a cover thumbnail.
// ============================================================================

export interface CaseSeries {
  seriesInstanceUID: string;
  studyInstanceUID: string;
  modality?: string;
  description?: string;
  seriesNumber?: number;
  /** Number of instances (slices/frames) in the series. */
  instanceCount: number;
  /** SOP Instance UID of a cover/first frame — enough for a thumbnail. */
  thumbnailInstanceUID?: string;
  /** WADO-RS root the viewer/thumbnail fetch through (our same-origin proxy). */
  wadoRsRoot: string;
}

/** Sentinel UIDs for the bundled offline sample expressed as a 1-series case. */
export const BUNDLED_STUDY_UID = "flowrad.bundled.study";
export const BUNDLED_SERIES_UID = "flowrad.bundled.series";

/** The bundled sample as a single-series `CaseSeries[]` (offline fallback). */
export const BUNDLED_CASE_SERIES: CaseSeries[] = [
  {
    seriesInstanceUID: BUNDLED_SERIES_UID,
    studyInstanceUID: BUNDLED_STUDY_UID,
    modality: "MR",
    description: "Sample MR (offline)",
    seriesNumber: 1,
    instanceCount: BUNDLED_CASE.kind === "wadouri" ? BUNDLED_CASE.frames : 0,
    wadoRsRoot: "/api/dicomweb",
  },
];

/**
 * Build the Cornerstone `ViewerSource` for one `CaseSeries`. The bundled-sample
 * sentinel resolves to the offline `wadouri` sample (so a single-series sample
 * case keeps working end to end); everything else is a `wadors` series served
 * through the proxy.
 */
export function caseSeriesToSource(s: CaseSeries): ViewerSource {
  if (s.studyInstanceUID === BUNDLED_STUDY_UID) return BUNDLED_CASE;
  return {
    kind: "wadors",
    wadoRsRoot: s.wadoRsRoot,
    StudyInstanceUID: s.studyInstanceUID,
    SeriesInstanceUID: s.seriesInstanceUID,
  };
}
