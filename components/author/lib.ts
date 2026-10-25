// Shared client helpers for the Author surface. Pure functions + the API
// calls the author UI makes. Every write goes through these so the page and
// cards share one code path (optimistic update + toast happen at the call site).

import type {
  CaptureSession,
  CaseData,
  Finding,
  Marker,
  NarrationSpan,
  RecordedTrack,
  StructuredFinding,
  StructuredSession,
} from "@/lib/types";

/** The structured (text) slice of a finding the author edits. */
export type FindingDraft = StructuredFinding;

/**
 * Prefer the author's last recorded cursor as the teaching marker when they
 * captured a walk-through but didn't click-to-annotate. Returns null if the
 * track has no cursor samples.
 */
export function markerFromTrack(track: RecordedTrack | null | undefined): Marker | null {
  if (!track?.events?.length) return null;
  for (let i = track.events.length - 1; i >= 0; i--) {
    const e = track.events[i];
    if (e.type === "cursor") {
      return { x_pct: e.x, y_pct: e.y, shape: "circle" };
    }
  }
  return null;
}

/** Pull the editable structured fields out of a finding. */
export function toDraft(f: Finding): FindingDraft {
  return {
    label: f.label,
    description: f.description,
    teachingPoints: [...f.teachingPoints],
    landmark: f.landmark ?? "",
  };
}

/** True when two drafts differ (drives the dirty/save state). */
export function draftsDiffer(a: FindingDraft, b: FindingDraft): boolean {
  if (a.label !== b.label) return true;
  if (a.description !== b.description) return true;
  if ((a.landmark ?? "") !== (b.landmark ?? "")) return true;
  if (a.teachingPoints.length !== b.teachingPoints.length) return true;
  return a.teachingPoints.some((p, i) => p !== b.teachingPoints[i]);
}

/** Trim a draft and drop blank teaching points before saving. */
export function normalizeDraft(d: FindingDraft): FindingDraft {
  return {
    label: d.label.trim(),
    description: d.description.trim(),
    teachingPoints: d.teachingPoints.map((p) => p.trim()).filter(Boolean),
    landmark: (d.landmark ?? "").trim(),
  };
}

/** Sensible limits so the structured text stays teaching-card sized. */
export const LIMITS = {
  label: 80,
  description: 600,
  teachingPoint: 200,
  teachingPoints: 8,
  landmark: 80,
} as const;

export interface DraftErrors {
  label?: string;
  description?: string;
  teachingPoints?: string;
  landmark?: string;
}

/** Validation: a finding must at least have a label; everything stays in range. */
export function validateDraft(d: FindingDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!d.label.trim()) errors.label = "A label is required.";
  else if (d.label.trim().length > LIMITS.label)
    errors.label = `Keep the label under ${LIMITS.label} characters.`;
  if (d.description.trim().length > LIMITS.description)
    errors.description = `Keep the description under ${LIMITS.description} characters.`;
  if ((d.landmark ?? "").trim().length > LIMITS.landmark)
    errors.landmark = `Keep the landmark under ${LIMITS.landmark} characters.`;
  const points = d.teachingPoints.map((p) => p.trim()).filter(Boolean);
  if (points.length > LIMITS.teachingPoints)
    errors.teachingPoints = `Use at most ${LIMITS.teachingPoints} teaching points.`;
  else if (points.some((p) => p.length > LIMITS.teachingPoint))
    errors.teachingPoints = `Keep each teaching point under ${LIMITS.teachingPoint} characters.`;
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

/** Persist a continuous-capture demonstration (parent track + transcript). */
export async function saveCaptureSession(
  caseId: string,
  session: CaptureSession
): Promise<CaseData> {
  const res = await fetch(`/api/cases/${caseId}/capture-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session),
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

/**
 * Distinguishes "AI is switched off" (no Gemini key) from a real failure, so the
 * UI can offer the manual path instead of treating it as an error. The route
 * surfaces the missing key as a 503 OR (today) as a 500 whose message mentions
 * GEMINI_API_KEY — we treat both as "unavailable" and never as a dead end.
 */
export class AiUnavailableError extends Error {
  constructor() {
    super("AI structuring is off — no Gemini key is configured.");
    this.name = "AiUnavailableError";
  }
}

function looksLikeMissingKey(status: number, message: unknown): boolean {
  if (status === 503) return true;
  return typeof message === "string" && /GEMINI_API_KEY/i.test(message);
}

/**
 * POST to /api/structure-finding with either a transcript or audio. Throws
 * {@link AiUnavailableError} when Gemini isn't configured so callers can degrade
 * to the manual path; throws a normal Error for genuine failures.
 */
async function structureRequest(
  body: { transcript: string } | { audioBase64: string; audioMime: string }
): Promise<StructuredFinding> {
  const res = await fetch("/api/structure-finding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (looksLikeMissingKey(res.status, data?.error)) throw new AiUnavailableError();
    throw new Error(data?.error || "Failed to structure finding");
  }
  return data as StructuredFinding;
}

/** Run Gemini structuring over a transcript. Returns the structured result. */
export async function structureFinding(transcript: string): Promise<StructuredFinding> {
  return structureRequest({ transcript });
}

/**
 * Structure a finding directly from recorded narration audio (Gemini does STT +
 * structuring in one call). Returns null when Gemini isn't configured so the
 * recorder flow degrades gracefully — the author still gets the track and fills
 * the text in by hand.
 */
export async function structureFindingFromAudio(
  base64: string,
  mime: string
): Promise<StructuredFinding | null> {
  try {
    return await structureRequest({ audioBase64: base64, audioMime: mime });
  } catch (e) {
    if (e instanceof AiUnavailableError) return null;
    throw e;
  }
}

/** Continuous take → transcript + ordered findings with time ranges. */
export async function structureSession(input: {
  audioBase64?: string;
  audioMime?: string;
  transcript?: string;
  durationMs: number;
  track?: RecordedTrack;
}): Promise<StructuredSession | null> {
  try {
    const res = await fetch("/api/structure-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (looksLikeMissingKey(res.status, data?.error)) throw new AiUnavailableError();
      throw new Error(data?.error || "Failed to structure session");
    }
    return data as StructuredSession;
  } catch (e) {
    if (e instanceof AiUnavailableError) return null;
    throw e;
  }
}

export interface AlignedNarration {
  transcript: string;
  spans: NarrationSpan[];
  alignment: "estimated" | "proportional";
}

/**
 * Transcribe a record take onto the track clock. Returns null when Gemini
 * is off or the call fails — the save still keeps the track and authored text.
 */
export async function transcribeNarrationAudio(
  base64: string,
  mime: string,
  durationMs: number
): Promise<AlignedNarration | null> {
  try {
    const res = await fetch("/api/transcribe-narration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: { base64, mime },
        durationMs,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (looksLikeMissingKey(res.status, data?.error)) return null;
      throw new Error(data?.error || "Failed to transcribe narration");
    }
    const spans = Array.isArray(data?.spans) ? (data.spans as NarrationSpan[]) : [];
    return {
      transcript: typeof data?.transcript === "string" ? data.transcript.trim() : "",
      spans,
      alignment: data?.alignment === "estimated" ? "estimated" : "proportional",
    };
  } catch (e) {
    if (e instanceof AiUnavailableError) return null;
    throw e;
  }
}

/**
 * Upload the mic (when present) and align a transcript to the track.
 * Failures stay non-fatal: the caller still saves the dense log.
 */
export async function attachTakeAudio(
  track: RecordedTrack,
  audio: { base64: string; mimeType: string } | null | undefined
): Promise<{ track: RecordedTrack; transcript: string }> {
  if (!audio) return { track, transcript: "" };
  let audioUrl = track.audioUrl;
  try {
    audioUrl = await uploadAudio(audio.base64, audio.mimeType);
  } catch {
    // The retrace still saves if the audio upload fails.
  }
  let narration = track.narration;
  let transcript = "";
  try {
    const aligned = await transcribeNarrationAudio(audio.base64, audio.mimeType, track.durationMs);
    if (aligned) {
      transcript = aligned.transcript;
      if (aligned.spans.length) narration = aligned.spans;
    }
  } catch {
    // Authored description still arms the script.
  }
  return {
    track: {
      ...track,
      ...(audioUrl ? { audioUrl } : {}),
      ...(narration?.length ? { narration } : {}),
    },
    transcript,
  };
}

/** Upload narration audio; returns the durable same-origin URL to store. */
export async function uploadAudio(base64: string, mimeType: string): Promise<string> {
  const res = await fetch("/api/audio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64, mimeType }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Failed to upload audio");
  return String(data.url);
}
