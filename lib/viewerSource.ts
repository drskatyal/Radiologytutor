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
