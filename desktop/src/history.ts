// The local study database: every study opened on this computer, where it
// lives and how to find it again — description, dates, modalities, series,
// body parts, accession and, when the reader allows it (Settings → "Include
// patient name and ID"), the patient's name and ID so they can be searched.
// Never pixels. Stored only on this computer (store.rs), capped at 1,000.

import type { OpenedSource, SourceKind, ViewerStudy } from "./types";

export interface HistoryEntry {
  key: string;
  paths: string[];
  kind: SourceKind;
  label: string;
  description: string;
  studyDate?: string;
  modalities: string[];
  studyCount: number;
  seriesCount: number;
  imageCount: number;
  openedAt: string;
  /** Series descriptions, for search ("FLAIR", "lung"). */
  seriesDescriptions?: string[];
  bodyParts?: string[];
  accession?: string;
  /** Only when patient indexing is on. */
  patient?: { name?: string; id?: string; birthDate?: string; sex?: string };
}

export function sourceKey(paths: readonly string[]): string {
  return [...paths].sort().join("|");
}

export function historyEntryFor(
  source: OpenedSource,
  studies: readonly ViewerStudy[],
  now = new Date(),
  options: { includePatient?: boolean } = {}
): HistoryEntry {
  const modalities = [...new Set(studies.flatMap((s) => s.modalities))];
  const described = studies.map((s) => s.description).filter(Boolean);
  return {
    key: source.key,
    paths: source.paths,
    kind: source.kind,
    label: source.label,
    description:
      described.length === 0
        ? ""
        : described.length === 1
          ? described[0]
          : `${described[0]} + ${described.length - 1} more`,
    studyDate: studies.map((s) => s.date).filter(Boolean).sort().pop(),
    modalities,
    studyCount: studies.length,
    seriesCount: studies.reduce((n, s) => n + s.series.length, 0),
    imageCount: studies.reduce((n, s) => n + s.imageCount, 0),
    openedAt: now.toISOString(),
    seriesDescriptions: [...new Set(studies.flatMap((s) => s.series.map((x) => x.description).filter(Boolean)))].slice(0, 60),
    bodyParts: [...new Set(studies.flatMap((s) => s.series.flatMap((x) => (x.headers[0]?.bodyPartExamined ? [x.headers[0].bodyPartExamined] : []))))],
    accession: studies.map((s) => s.accession).find(Boolean),
    ...(options.includePatient && studies[0]
      ? {
          patient: {
            name: studies[0].patient.name,
            id: studies[0].patient.id,
            birthDate: studies[0].patient.birthDate,
            sex: studies[0].patient.sex,
          },
        }
      : {}),
  };
}

const fold = (v: string) => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Everything an entry can be found by, folded to lower case without accents. */
function haystack(e: HistoryEntry): string {
  const date = e.studyDate ?? "";
  const pretty = /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : "";
  return fold(
    [
      e.description,
      e.label,
      e.modalities.join(" "),
      date,
      pretty,
      e.accession,
      ...(e.seriesDescriptions ?? []),
      ...(e.bodyParts ?? []),
      // DICOM PN "DOE^JANE" → "doe jane"
      e.patient?.name?.replace(/\^/g, " "),
      e.patient?.id,
      e.patient?.birthDate,
      ...e.paths,
    ]
      .filter(Boolean)
      .join(" \u0000 ")
  );
}

/**
 * Search the local database: every word of the query must appear somewhere
 * in the entry (any field, any order, accent- and case-insensitive). Newest
 * opened first, as stored.
 */
export function searchHistory(entries: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => {
    const text = haystack(e);
    return words.every((w) => text.includes(w));
  });
}

/**
 * Earlier studies of the same patient in the local study database (needs
 * "Include patient name and ID"), newest first: the "Compare with prior" list.
 */
export function priorsFor(history: readonly HistoryEntry[], current: { key: string; patientId?: string; studyDate?: string }): HistoryEntry[] {
  if (!current.patientId) return [];
  return history
    .filter((h) => h.key !== current.key && h.patient?.id === current.patientId)
    .filter((h) => !current.studyDate || !h.studyDate || h.studyDate <= current.studyDate)
    .sort((a, b) => (b.studyDate ?? "").localeCompare(a.studyDate ?? ""));
}
