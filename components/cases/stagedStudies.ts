// Staged-study model used by the create-case flow (CreateCaseFlow). A "staged
// study" is one DICOM study assembled
// from one or more upload batches: grouped by StudyInstanceUID and SeriesInstance
// UID so re-uploading the same study/series accumulates instead of duplicating.

import type { SeriesOption } from "./SeriesPicker";
import type { StudyRole, UploadResult } from "@/components/admin/types";

/** One uploaded study staged for the case (grouped from upload result[s]). */
export interface StagedStudy {
  key: string;
  studyInstanceUID: string;
  description: string;
  modality?: string;
  studyDate?: string;
  orthancStudyId?: string;
  series: SeriesOption[];
  /** Series UIDs the case uses (first = primary). */
  selected: string[];
  primary?: string;
  role: StudyRole;
}

/**
 * Merge an upload result (one batch) into the staged-studies list, grouping by
 * StudyInstanceUID and by SeriesInstanceUID so multiple batches of the SAME
 * study/series accumulate instead of duplicating. Returns the next list plus the
 * first newly-seen study (for metadata auto-fill).
 */
export function mergeUpload(
  prev: StagedStudy[],
  result: UploadResult
): { next: StagedStudy[]; firstNewStudy?: StagedStudy } {
  const next = prev.map((s) => ({ ...s, series: [...s.series], selected: [...s.selected] }));
  const byUid = new Map(next.map((s) => [s.studyInstanceUID, s]));
  let firstNewStudy: StagedStudy | undefined;

  for (const s of result.series) {
    let study = byUid.get(s.studyInstanceUID);
    if (!study) {
      study = {
        key: s.studyInstanceUID,
        studyInstanceUID: s.studyInstanceUID,
        description: s.studyDescription || "Uploaded study",
        modality: s.modality,
        studyDate: s.studyDate,
        orthancStudyId: s.orthancStudyId,
        series: [],
        selected: [],
        // First study uploaded is "current"; later ones default to "prior".
        role: next.length === 0 ? "current" : "prior",
      };
      byUid.set(s.studyInstanceUID, study);
      next.push(study);
      if (!firstNewStudy) firstNewStudy = study;
    }
    if (!study.orthancStudyId && s.orthancStudyId) study.orthancStudyId = s.orthancStudyId;
    if (!study.modality && s.modality) study.modality = s.modality;
    if (!study.studyDate && s.studyDate) study.studyDate = s.studyDate;

    const existing = study.series.find((x) => x.seriesInstanceUID === s.seriesInstanceUID);
    if (existing) {
      existing.instanceCount = (existing.instanceCount ?? 0) + s.instances;
      if (!existing.modality && s.modality) existing.modality = s.modality;
      if (!existing.firstInstanceUID && s.firstInstanceUID)
        existing.firstInstanceUID = s.firstInstanceUID;
    } else {
      study.series.push({
        seriesInstanceUID: s.seriesInstanceUID,
        label:
          s.seriesDescription ||
          s.studyDescription ||
          `Series …${s.seriesInstanceUID.slice(-6)}`,
        modality: s.modality,
        instanceCount: s.instances,
        studyInstanceUID: s.studyInstanceUID,
        firstInstanceUID: s.firstInstanceUID,
      });
    }
  }

  // Ensure every study has a primary/selection default (first series).
  for (const study of next) {
    if (study.selected.length === 0 && study.series[0]) {
      study.selected = [study.series[0].seriesInstanceUID];
      study.primary = study.series[0].seriesInstanceUID;
    }
  }
  return { next, firstNewStudy };
}

/** Total uploaded images across every staged study. */
export function totalStagedImages(studies: StagedStudy[]): number {
  return studies.reduce(
    (n, s) => n + s.series.reduce((m, x) => m + (x.instanceCount ?? 0), 0),
    0
  );
}

/** Build the API study payload from staged studies (primary series first). */
export function toStudyPayload(studies: StagedStudy[]) {
  return studies.map((s) => {
    const ordered = s.primary
      ? [s.primary, ...s.selected.filter((u) => u !== s.primary)]
      : s.selected;
    return {
      studyInstanceUID: s.studyInstanceUID,
      seriesInstanceUIDs: s.series.map((x) => x.seriesInstanceUID),
      description: s.description,
      modality: s.modality,
      studyDate: s.studyDate,
      orthancStudyId: s.orthancStudyId,
      caseSeriesInstanceUIDs: ordered,
      role: s.role,
    };
  });
}
