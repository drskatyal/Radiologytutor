// Browser upload planning: group the files a reader picked into studies and
// series (by their ORIGINAL UIDs, which never leave the device), choose sensible
// defaults, and describe each study with the anonymised UIDs the server will
// see. Pure: the dialog feeds it parsed headers.

import { remapUid } from "./anonymize";

export interface ScannedFile {
  /** Index into the picked File list. */
  index: number;
  bytes: number;
  studyUid: string;
  seriesUid: string;
  modality?: string;
  seriesDescription?: string;
  seriesNumber?: number;
  studyDescription?: string;
}

export interface PlannedSeries {
  seriesUid: string;
  modality?: string;
  description?: string;
  seriesNumber?: number;
  fileIndexes: number[];
  bytes: number;
  /** Selected for upload by default. */
  defaultSelected: boolean;
  /** Why it is not selected by default (shown to the reader). */
  caution?: string;
}

export interface PlannedStudy {
  studyUid: string;
  description?: string;
  modalities: string[];
  series: PlannedSeries[];
}

/**
 * Series types that often carry identifiers in their pixels or text (dose
 * reports, scanned requisitions, structured reports, screen captures). They
 * start unticked; the reader can still choose them.
 */
const CAUTION: Record<string, string> = {
  SR: "Structured report: may contain names in text",
  DOC: "Document: may contain patient details",
  OT: "Other / screen capture: check for burned-in text",
  PR: "Presentation state",
  KO: "Key image note",
};

export function planUpload(files: readonly ScannedFile[]): PlannedStudy[] {
  const studies = new Map<string, PlannedStudy>();
  const series = new Map<string, PlannedSeries>();
  for (const f of files) {
    let study = studies.get(f.studyUid);
    if (!study) {
      study = { studyUid: f.studyUid, description: f.studyDescription, modalities: [], series: [] };
      studies.set(f.studyUid, study);
    }
    const key = `${f.studyUid}\u0000${f.seriesUid}`;
    let s = series.get(key);
    if (!s) {
      const caution = f.modality ? CAUTION[f.modality.toUpperCase()] : undefined;
      s = {
        seriesUid: f.seriesUid,
        modality: f.modality,
        description: f.seriesDescription,
        seriesNumber: f.seriesNumber,
        fileIndexes: [],
        bytes: 0,
        defaultSelected: !caution,
        caution,
      };
      series.set(key, s);
      study.series.push(s);
      if (f.modality && !study.modalities.includes(f.modality)) study.modalities.push(f.modality);
    }
    s.fileIndexes.push(f.index);
    s.bytes += f.bytes;
  }
  for (const study of studies.values()) {
    study.series.sort((a, b) => (a.seriesNumber ?? 1e9) - (b.seriesNumber ?? 1e9));
  }
  return [...studies.values()];
}

export function defaultStudyTitle(study: Pick<PlannedStudy, "description" | "modalities">): string {
  const desc = study.description?.trim();
  const mod = study.modalities.join("/");
  if (desc) return mod && !desc.toUpperCase().startsWith(mod.toUpperCase()) ? `${mod} ${desc}` : desc;
  return mod ? `${mod} study` : "Untitled study";
}

/** The body for POST /api/studies, with UIDs remapped exactly as the anonymiser will. */
export function newStudyRequest(study: PlannedStudy, selected: ReadonlySet<string>, salt: string, title: string) {
  const chosen = study.series.filter((s) => selected.has(s.seriesUid));
  return {
    studyInstanceUID: remapUid(study.studyUid, salt),
    title,
    modality: study.modalities.join("/") || undefined,
    description: study.description,
    series: chosen.map((s) => ({
      seriesInstanceUID: remapUid(s.seriesUid, salt),
      modality: s.modality,
      description: s.description,
      seriesNumber: s.seriesNumber,
      instanceCount: s.fileIndexes.length,
    })),
    bytes: chosen.reduce((n, s) => n + s.bytes, 0),
  };
}
