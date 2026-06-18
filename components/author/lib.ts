// Shared client helpers for the Author surface. Pure functions + the API
// calls the author UI makes. Every write goes through these so the page and
// cards share one code path (optimistic update + toast happen at the call site).

import type { CaseData, Finding, StructuredFinding } from "@/lib/types";

/** The structured (text) slice of a finding the author edits. */
export type FindingDraft = StructuredFinding;

/** Pull the editable structured fields out of a finding. */
export function toDraft(f: Finding): FindingDraft {
  return {
    label: f.label,
    description: f.description,
    teachingPoints: [...f.teachingPoints],
  };
}

/** True when two drafts differ (drives the dirty/save state). */
export function draftsDiffer(a: FindingDraft, b: FindingDraft): boolean {
  if (a.label !== b.label) return true;
  if (a.description !== b.description) return true;
  if (a.teachingPoints.length !== b.teachingPoints.length) return true;
  return a.teachingPoints.some((p, i) => p !== b.teachingPoints[i]);
}

/** Trim a draft and drop blank teaching points before saving. */
export function normalizeDraft(d: FindingDraft): FindingDraft {
  return {
    label: d.label.trim(),
    description: d.description.trim(),
    teachingPoints: d.teachingPoints.map((p) => p.trim()).filter(Boolean),
  };
}

export interface DraftErrors {
  label?: string;
}

/** Validation: a finding must at least have a label. */
export function validateDraft(d: FindingDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!d.label.trim()) errors.label = "A label is required.";
  return errors;
}

export function hasErrors(e: DraftErrors): boolean {
  return Object.keys(e).length > 0;
}

// ---------------------------------------------------------------------------
// API surface — thin wrappers over the existing case/finding routes. They throw
// on failure so callers can toast + roll back.
// ---------------------------------------------------------------------------

async function jsonOrThrow(res: Response): Promise<CaseData> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as CaseData;
}

/** List every case (used by the picker). */
export async function fetchCases(): Promise<CaseData[]> {
  const res = await fetch("/api/cases", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load cases");
  return (await res.json()) as CaseData[];
}

/** Re-read a single case (used after navigation / to refresh). */
export async function fetchCase(caseId: string): Promise<CaseData> {
  const res = await fetch(`/api/cases/${caseId}`, { cache: "no-store" });
  return jsonOrThrow(res);
}

/** Patch a finding's structured fields. Returns the updated case. */
export async function patchFinding(
  caseId: string,
  findingId: string,
  patch: Partial<Finding>
): Promise<CaseData> {
  const res = await fetch(`/api/cases/${caseId}/findings/${findingId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow(res);
}

/** Delete a finding. Returns the updated case. */
export async function deleteFinding(caseId: string, findingId: string): Promise<CaseData> {
  const res = await fetch(`/api/cases/${caseId}/findings/${findingId}`, {
    method: "DELETE",
  });
  return jsonOrThrow(res);
}

/** Append a new finding. The API requires `state` + `marker`. */
export async function addFinding(
  caseId: string,
  finding: Partial<Finding>
): Promise<CaseData> {
  const res = await fetch(`/api/cases/${caseId}/findings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(finding),
  });
  return jsonOrThrow(res);
}

/** Persist a new teaching order. Returns the updated case. */
export async function reorderFindings(
  caseId: string,
  orderedIds: string[]
): Promise<CaseData> {
  const res = await fetch(`/api/cases/${caseId}/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderedIds }),
  });
  return jsonOrThrow(res);
}

/** Run Gemini structuring over a transcript. Returns the structured result. */
export async function structureFinding(transcript: string): Promise<StructuredFinding> {
  const res = await fetch("/api/structure-finding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Failed to structure finding");
  return data as StructuredFinding;
}
