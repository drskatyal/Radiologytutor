// Local study history. What is kept is deliberately thin: where the study
// lives and how to recognise it in a list. No patient identifiers, no pixels
// (docs/DESKTOP_PLAN.md §5) — a recent-files list must not leak PHI.

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
}

export function sourceKey(paths: readonly string[]): string {
  return [...paths].sort().join("|");
}

export function historyEntryFor(source: OpenedSource, studies: readonly ViewerStudy[], now = new Date()): HistoryEntry {
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
  };
}
