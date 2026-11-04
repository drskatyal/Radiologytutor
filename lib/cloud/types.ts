// Data model for FlowRad Viewer accounts (the "store and share" side).
// The free viewer has no model at all: files stay on the device.

import type { PlanId } from "./plans";
import type { Share } from "./shares";
import type { RecordedAnnotation } from "@/lib/types";

export type { Share };

export interface Account {
  /** Identity provider user id (Identity Platform uid, or dev-<hash>). */
  id: string;
  email: string;
  name?: string;
  plan: PlanId;
  /** Secret per-account salt for anonymised UIDs (never sent to other users). */
  uidSalt: string;
  createdAt: string;
}

/** One saved annotation, tied to the series it was drawn on. */
export interface MarkupItem {
  seriesInstanceUID: string;
  annotation: RecordedAnnotation;
}

export type StudyStatus = "uploading" | "ready";

export interface StudySeriesSummary {
  seriesInstanceUID: string;
  modality?: string;
  description?: string;
  seriesNumber?: number;
  instanceCount: number;
}

export interface Study {
  id: string;
  ownerId: string;
  /** Anonymised (remapped) StudyInstanceUID in the archive. */
  studyInstanceUID: string;
  status: StudyStatus;
  title: string;
  modality?: string;
  /** Anonymised StudyDescription (dates/identifiers removed in the browser). */
  description?: string;
  series: StudySeriesSummary[];
  instanceCount: number;
  bytes: number;
  /** Teaching text. */
  history: string;
  findings: string;
  diagnosis: string;
  tags: string[];
  markup: MarkupItem[];
  createdAt: string;
  updatedAt: string;
}

export interface Collection {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  studyIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** Editable study fields (PATCH body). */
export type StudyPatch = Partial<Pick<Study, "title" | "history" | "findings" | "diagnosis" | "tags" | "markup">>;
export type CollectionPatch = Partial<Pick<Collection, "name" | "description" | "studyIds">>;

export const LIMITS = {
  title: 200,
  history: 4000,
  findings: 8000,
  diagnosis: 500,
  tag: 40,
  tags: 20,
  markup: 500,
  collectionName: 120,
  collectionDescription: 2000,
} as const;

/** Normalise free-form tags: trimmed, lower-case, unique, bounded. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const v = t.trim().toLowerCase().replace(/\s+/g, " ").slice(0, LIMITS.tag);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

function boundedText(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

/** Validate an untrusted study PATCH. Unknown keys are ignored. */
export function parseStudyPatch(body: unknown): StudyPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: StudyPatch = {};
  const title = boundedText(b.title, LIMITS.title);
  if (title !== undefined) patch.title = title.trim() || "Untitled study";
  const history = boundedText(b.history, LIMITS.history);
  if (history !== undefined) patch.history = history;
  const findings = boundedText(b.findings, LIMITS.findings);
  if (findings !== undefined) patch.findings = findings;
  const diagnosis = boundedText(b.diagnosis, LIMITS.diagnosis);
  if (diagnosis !== undefined) patch.diagnosis = diagnosis;
  if (b.tags !== undefined) patch.tags = normalizeTags(b.tags);
  if (b.markup !== undefined) patch.markup = parseMarkup(b.markup);
  return patch;
}

const num01 = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= -0.5 && v <= 1.5;
const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && num01(v[0]) && num01(v[1]);

export function parseMarkup(raw: unknown): MarkupItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MarkupItem[] = [];
  for (const item of raw.slice(0, LIMITS.markup)) {
    const m = item as { seriesInstanceUID?: unknown; annotation?: Record<string, unknown> };
    const a = m?.annotation;
    if (typeof m?.seriesInstanceUID !== "string" || !/^[0-9.]{3,64}$/.test(m.seriesInstanceUID) || !a) continue;
    if (!pair(a.from) || !pair(a.to) || (a.shape !== "circle" && a.shape !== "arrow")) continue;
    const handles = Array.isArray(a.handles) ? (a.handles as unknown[]).filter(pair).slice(0, 64) : undefined;
    const numOrUndef = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    out.push({
      seriesInstanceUID: m.seriesInstanceUID,
      annotation: {
        shape: a.shape as RecordedAnnotation["shape"],
        from: a.from,
        to: a.to,
        tool: typeof a.tool === "string" ? a.tool.slice(0, 40) : undefined,
        handles,
        sliceIndex: Number.isInteger(a.sliceIndex) ? (a.sliceIndex as number) : undefined,
        label: typeof a.label === "string" ? a.label.slice(0, 200) : undefined,
        lengthMm: numOrUndef(a.lengthMm),
        meanHu: numOrUndef(a.meanHu),
        maxHu: numOrUndef(a.maxHu),
        minHu: numOrUndef(a.minHu),
        stdHu: numOrUndef(a.stdHu),
        areaMm2: numOrUndef(a.areaMm2),
        unit: typeof a.unit === "string" ? a.unit.slice(0, 16) : undefined,
      },
    });
  }
  return out;
}

export function parseCollectionPatch(body: unknown): CollectionPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: CollectionPatch = {};
  const name = boundedText(b.name, LIMITS.collectionName);
  if (name !== undefined) patch.name = name.trim() || "Untitled collection";
  const description = boundedText(b.description, LIMITS.collectionDescription);
  if (description !== undefined) patch.description = description;
  if (Array.isArray(b.studyIds)) {
    patch.studyIds = [...new Set(b.studyIds.filter((x): x is string => typeof x === "string" && /^[\w-]{6,64}$/.test(x)))].slice(0, 2000);
  }
  return patch;
}
