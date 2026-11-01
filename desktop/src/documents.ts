// Structured reports and key-image notes that came with a study
// (desktop/src-tauri/src/documents.rs reads them during the scan).

import type { ViewerSeries, ViewerStudy } from "./types";

export interface DicomDocument {
  kind: "sr" | "ko";
  fileName: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  title: string;
  date?: string;
  /** Content tree, one line per item, two-space indent per level. */
  lines: string[];
  /** SOP Instance UIDs it points at. */
  references: string[];
}

/**
 * Each key-image note becomes a series of exactly the images it selects, in
 * the order the note lists them, added to its study (so it hangs, scrolls and
 * exports like any series). Notes whose images are not in this study are skipped.
 */
export function withKeyImageSeries(studies: ViewerStudy[], documents: readonly DicomDocument[]): ViewerStudy[] {
  const notes = documents.filter((d) => d.kind === "ko" && d.references.length);
  if (!notes.length) return studies;
  return studies.map((study) => {
    const mine = notes.filter((d) => !d.studyInstanceUid || d.studyInstanceUid === study.uid);
    if (!mine.length) return study;
    const index = new Map<string, { series: ViewerSeries; i: number }>();
    for (const series of study.series)
      series.headers.forEach((h, i) => {
        if (h.sopInstanceUID && !index.has(h.sopInstanceUID)) index.set(h.sopInstanceUID, { series, i });
      });
    const extra: ViewerSeries[] = [];
    for (const note of mine) {
      const hits = note.references.map((uid) => index.get(uid)).filter((x): x is { series: ViewerSeries; i: number } => !!x);
      if (!hits.length) continue;
      extra.push({
        uid: `ko:${note.sopInstanceUid ?? note.fileName}`,
        studyUid: study.uid,
        modality: "KO",
        description: `Key images${note.title && note.title !== "Key images" ? ` · ${note.title}` : ""}`,
        imageIds: hits.map(({ series, i }) => series.imageIds[i]),
        headers: hits.map(({ series, i }) => series.headers[i]),
        imageCount: hits.length,
        multiframe: false,
        volumetric: false,
        frameOfReferenceUid: hits[0].series.frameOfReferenceUid,
      });
    }
    return extra.length ? { ...study, series: [...extra, ...study.series] } : study;
  });
}

/** Structured reports for a study, for the series browser's Reports list. */
export function reportsFor(study: ViewerStudy, documents: readonly DicomDocument[]): DicomDocument[] {
  return documents.filter((d) => d.kind === "sr" && (!d.studyInstanceUid || d.studyInstanceUid === study.uid));
}
