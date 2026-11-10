// The shared viewer shell's source adapter: where a study's series and pixels
// come from, behind one contract.
//
//   local  files opened from this computer (FlowRad free viewer, /viewer and
//          /viewer/local). Headers are parsed on device; every series is
//          already a list of `dicomfile:` imageIds.
//   cloud  series in the archive, reached through /api/dicomweb. A pane gets a
//          `wadors` ViewerSource and CornerstoneViewer opens it the way the
//          RadLearn case viewer always has: the converted HTJ2K bundle when
//          lib/dicomCdn has one (preview first), else lib/progressiveStack
//          (opening slice first, then the slim series index).
//
// The shell (components/viewer/ViewerFrame.tsx) only ever talks to this
// contract, so the same reading frame — series panel, hanging layouts, panes,
// one toolbar — serves both products. Teaching and recording are layered on in
// RadLearn later; nothing here knows about them.
//
// Pure: no React, no Cornerstone. The study model is viewer-core's LocalStudy
// shape, which is all the frame reads; a cloud series simply has no
// per-instance headers until the viewer has loaded it.

import type { LocalSeries, LocalStudy } from "@flowrad/viewer-core/localStudy";
import { seriesImageIds } from "./localDicomFiles";
import { seriesThumbUrl } from "./seriesRail";
import { caseSeriesToSource, type CaseSeries, type ViewerSource } from "./viewerSource";

export type StudySourceKind = "local" | "cloud";

export interface StudySourceAdapter {
  kind: StudySourceKind;
  /** Studies in display order, each with its series. */
  readonly studies: readonly LocalStudy[];
  /**
   * The ordered imageIds of a series when they are already known (local
   * files). Null for a cloud series: the viewer resolves them itself.
   */
  imageIds(series: LocalSeries): string[] | null;
  /** What a pane loads to show `series`. Null when there is nothing to paint. */
  viewerSource(series: LocalSeries): ViewerSource | null;
  /** A cover image URL for the series panel, when the source can serve one. */
  thumbnailUrl(series: LocalSeries): string | null;
  /** The files behind a series (export, anonymised copy). Local only. */
  files?: (series: LocalSeries) => Promise<File[]>;
}

// --- local ------------------------------------------------------------------

export interface LocalSourceInput {
  studies: readonly LocalStudy[];
  imageIdsByFile: ReadonlyMap<string, readonly string[]>;
  /** viewer-core's localSeriesFiles, injected so this module stays pure. */
  seriesFiles?: (series: LocalSeries, imageIdsByFile: ReadonlyMap<string, readonly string[]>) => Promise<File[]>;
}

/** Files opened from this computer. Exactly what LocalStudyViewer did inline. */
export function localStudySource(input: LocalSourceInput): StudySourceAdapter {
  const byFile = input.imageIdsByFile as Map<string, string[]>;
  const ids = (series: LocalSeries) => seriesImageIds(series, byFile);
  return {
    kind: "local",
    studies: input.studies,
    imageIds: ids,
    viewerSource(series) {
      const imageIds = ids(series);
      if (imageIds.length === 0) return null;
      return { kind: "imageIds", key: series.seriesInstanceUID, imageIds };
    },
    // Local covers are rendered on device from the files (lib/localThumbnails).
    thumbnailUrl: () => null,
    files: input.seriesFiles ? (series) => input.seriesFiles!(series, input.imageIdsByFile) : undefined,
  };
}

// --- cloud ------------------------------------------------------------------

/**
 * Archive series through /api/dicomweb. Series are grouped into studies in
 * the order they arrive (a case lists its current study first), each study's
 * series kept in the given order.
 */
export function cloudStudySource(series: readonly CaseSeries[]): StudySourceAdapter {
  const studies: LocalStudy[] = [];
  const byUid = new Map<string, CaseSeries>();
  for (const item of series) {
    if (!item.seriesInstanceUID || !item.studyInstanceUID) continue;
    byUid.set(item.seriesInstanceUID, item);
    let study = studies.find((s) => s.studyInstanceUID === item.studyInstanceUID);
    if (!study) {
      study = { studyInstanceUID: item.studyInstanceUID, series: [], imageCount: 0 };
      studies.push(study);
    }
    const count = item.instanceCount && item.instanceCount > 0 ? item.instanceCount : 0;
    study.series.push({
      seriesInstanceUID: item.seriesInstanceUID,
      studyInstanceUID: item.studyInstanceUID,
      modality: item.modality,
      seriesNumber: item.seriesNumber,
      description: item.description,
      instances: [],
      imageCount: count,
    });
    study.imageCount += count;
  }
  const original = (s: LocalSeries) => byUid.get(s.seriesInstanceUID) ?? null;
  return {
    kind: "cloud",
    studies,
    imageIds: () => null,
    viewerSource(s) {
      const item = original(s);
      // A `wadors` source: CornerstoneViewer → lib/dicomCdn bundle when the
      // series was converted, else lib/progressiveStack.
      return item ? caseSeriesToSource(item) : null;
    },
    thumbnailUrl(s) {
      const item = original(s);
      return item ? seriesThumbUrl(item) : null;
    },
  };
}
