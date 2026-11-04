// Validation for "create a stored study" (the browser sends this after it has
// anonymised the files and before it uploads them). Pure, unit-tested.

import { LIMITS, type StudySeriesSummary } from "./types";

/** An anonymised UID: the browser anonymiser only produces 2.25 UIDs. */
export const ANON_UID_RE = /^2\.25\.\d{1,39}$/;

export interface NewStudyInput {
  studyInstanceUID: string;
  title: string;
  modality?: string;
  description?: string;
  series: StudySeriesSummary[];
  instanceCount: number;
  bytes: number;
}

const short = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function parseNewStudy(body: unknown): NewStudyInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const uid = typeof b.studyInstanceUID === "string" ? b.studyInstanceUID.trim() : "";
  if (!ANON_UID_RE.test(uid)) return "The study must be anonymised in the browser before upload.";
  const rawSeries = Array.isArray(b.series) ? b.series.slice(0, 500) : [];
  const series: StudySeriesSummary[] = [];
  for (const r of rawSeries) {
    const s = r as Record<string, unknown>;
    const seriesUid = typeof s.seriesInstanceUID === "string" ? s.seriesInstanceUID.trim() : "";
    const count = Number(s.instanceCount);
    if (!ANON_UID_RE.test(seriesUid) || !Number.isInteger(count) || count < 1) continue;
    series.push({
      seriesInstanceUID: seriesUid,
      modality: short(s.modality, 16),
      description: short(s.description, 128),
      seriesNumber: Number.isInteger(s.seriesNumber) ? (s.seriesNumber as number) : undefined,
      instanceCount: count,
    });
  }
  if (!series.length) return "Choose at least one series to store.";
  const instanceCount = series.reduce((n, s) => n + s.instanceCount, 0);
  const bytes = Number(b.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return "Missing study size.";
  return {
    studyInstanceUID: uid,
    title: short(b.title, LIMITS.title) ?? "Untitled study",
    modality: short(b.modality, 32),
    description: short(b.description, 128),
    series,
    instanceCount,
    bytes: Math.round(bytes),
  };
}

/** Largest single instance we accept (Cloud Run caps an HTTP/1 request at 32 MiB). */
export const MAX_INSTANCE_BYTES = 30 * 1024 * 1024;
