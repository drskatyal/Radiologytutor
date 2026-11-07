// Shared client helpers for the Author surface. Pure functions + the API
// calls the author UI makes. Every write goes through these so the page and
// cards share one code path (optimistic update + toast happen at the call site).

import type {
  CaptureSession,
  CaseData,
  Finding,
  FindingMeasurement,
  Marker,
  NarrationSpan,
  RecordedTrack,
  StructuredFinding,
  StructuredSession,
} from "@/lib/types";
import {
  commitRecordedFinding,
  narrationFromTranscribeResult,
  type RecordedSaveReceipt,
} from "@/lib/teachingGuide";
import { prepareCompileFrames, type CompileFrame } from "@/lib/compileMedia";

/** The structured (text) slice of a finding the author edits. */
export type FindingDraft = StructuredFinding & {
  /** Gold report sentence. Blank when this finding has no report rubric. */
  reportGold?: string;
  /** Phrases the report must include. Empty when unset. */
  reportMustMention?: string[];
};

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
    reportGold: f.reportGold ?? "",
    reportMustMention: [...(f.reportMustMention ?? [])],
  };
}

/** True when two drafts differ (drives the dirty/save state). */
export function draftsDiffer(a: FindingDraft, b: FindingDraft): boolean {
  if (a.label !== b.label) return true;
  if (a.description !== b.description) return true;
  if ((a.landmark ?? "") !== (b.landmark ?? "")) return true;
  if ((a.reportGold ?? "") !== (b.reportGold ?? "")) return true;
  if (a.teachingPoints.length !== b.teachingPoints.length) return true;
  if (a.teachingPoints.some((p, i) => p !== b.teachingPoints[i])) return true;
  const aPhrases = a.reportMustMention ?? [];
  const bPhrases = b.reportMustMention ?? [];
  if (aPhrases.length !== bPhrases.length) return true;
  return aPhrases.some((p, i) => p !== bPhrases[i]);
}

/** Trim a draft and drop blank teaching points before saving. */
export function normalizeDraft(d: FindingDraft): FindingDraft {
  return {
    label: d.label.trim(),
    description: d.description.trim(),
    teachingPoints: d.teachingPoints.map((p) => p.trim()).filter(Boolean),
    landmark: (d.landmark ?? "").trim(),
    reportGold: (d.reportGold ?? "").trim(),
    reportMustMention: (d.reportMustMention ?? []).map((p) => p.trim()).filter(Boolean),
  };
}

/** Sensible limits so the structured text stays teaching-card sized. */
export const LIMITS = {
  label: 80,
  description: 600,
  teachingPoint: 200,
  teachingPoints: 8,
  landmark: 80,
  reportGold: 400,
  reportPhrase: 80,
  reportPhrases: 6,
} as const;

export interface DraftErrors {
  label?: string;
  description?: string;
  teachingPoints?: string;
  landmark?: string;
  reportGold?: string;
  reportMustMention?: string;
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
  if ((d.reportGold ?? "").trim().length > LIMITS.reportGold)
    errors.reportGold = `Keep the gold line under ${LIMITS.reportGold} characters.`;
  const phrases = (d.reportMustMention ?? []).map((p) => p.trim()).filter(Boolean);
  if (phrases.length > LIMITS.reportPhrases)
    errors.reportMustMention = `Use at most ${LIMITS.reportPhrases} rubric phrases.`;
  else if (phrases.some((p) => p.length > LIMITS.reportPhrase))
    errors.reportMustMention = `Keep each rubric phrase under ${LIMITS.reportPhrase} characters.`;
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

/** Write the LiveTeachingPack. The server rebuilds anchors from the stored track. */
export async function commitLiveTeachingPack(
  caseId: string,
  body: {
    captureSessionId: string;
    transcript?: string;
    seriesInstanceUID?: string;
    studyInstanceUID?: string;
    findings: Array<{
      label: string;
      description?: string;
      teachingPoints?: string[];
      whatToNotice?: string;
      pearl?: string;
      mimics?: string[];
      clinicalImportance?: number;
      whyClinicallyFirst?: string;
      reportLine?: string;
      landmark?: string;
      tStartMs: number;
      tEndMs: number;
    }>;
  }
): Promise<CaseData> {
  const res = await fetch(`/api/cases/${caseId}/live-teaching-pack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

/** Viewport recording → Gemini Files API. The key stays on the server. */
export async function uploadTeachingVideo(
  blob: Blob
): Promise<{ fileUri: string; mimeType: string }> {
  const body = new FormData();
  body.set("video", blob, "viewport.webm");
  const res = await fetch("/api/gemini/files", { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (looksLikeMissingKey(res.status, data?.error)) throw new AiUnavailableError();
    throw new Error(data?.error || "Couldn't upload the viewport recording");
  }
  if (typeof data?.fileUri !== "string" || !data.fileUri) {
    throw new Error("Viewport upload did not return a file");
  }
  return {
    fileUri: data.fileUri,
    mimeType: typeof data.mimeType === "string" ? data.mimeType : "video/webm",
  };
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
  body:
    | { transcript: string }
    | { audioBase64: string; audioMime: string; frames?: CompileFrame[] }
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
  mime: string,
  frames?: CompileFrame[]
): Promise<StructuredFinding | null> {
  try {
    const prepared = frames?.length ? prepareCompileFrames(frames) : [];
    return await structureRequest(
      prepared.length
        ? { audioBase64: base64, audioMime: mime, frames: prepared }
        : { audioBase64: base64, audioMime: mime }
    );
  } catch (e) {
    if (e instanceof AiUnavailableError) return null;
    throw e;
  }
}

/** Continuous take → transcript + findings ranked by clinical importance. */
export async function structureSession(input: {
  audioBase64?: string;
  audioMime?: string;
  transcript?: string;
  durationMs: number;
  track?: RecordedTrack;
  frames?: CompileFrame[];
  study?: {
    title?: string;
    modality?: string;
    specialty?: string;
    clinicalHistory?: string;
    patientAge?: string;
    patientSex?: string;
  };
  caseId?: string;
  modality?: string;
  clinicalQuestion?: string;
  diagnosis?: string;
  studySeriesUIDs?: string[];
  /** Files API reference for a long viewport recording. */
  video?: { fileUri: string; mimeType: string };
}): Promise<StructuredSession | null> {
  try {
    const { frames: rawFrames, ...rest } = input;
    const frames = rawFrames?.length ? prepareCompileFrames(rawFrames) : [];
    const res = await fetch("/api/structure-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rest, ...(frames.length ? { frames } : {}) }),
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
    if (!res.ok) return null;
    const spans = Array.isArray(data?.spans) ? (data.spans as NarrationSpan[]) : [];
    return {
      transcript: typeof data?.transcript === "string" ? data.transcript.trim() : "",
      spans,
      alignment: data?.alignment === "estimated" ? "estimated" : "proportional",
    };
  } catch {
    return null;
  }
}

export interface AttachedTake {
  track: RecordedTrack;
  transcript: string;
  published: AlignedNarration | null;
  gap: "none" | "empty-mic" | "empty-transcript" | "stt-failed";
}

/**
 * Upload the mic (when present) and align a transcript to the track.
 * Upload and transcription failures stay non-fatal: the caller still saves
 * the dense log and builds the teach script from authored prose.
 */
export async function attachTakeAudio(
  track: RecordedTrack,
  audio: { base64: string; mimeType: string } | null | undefined
): Promise<AttachedTake> {
  if (!audio?.base64) {
    return { track, transcript: "", published: null, gap: "empty-mic" };
  }
  let audioUrl = track.audioUrl;
  try {
    audioUrl = await uploadAudio(audio.base64, audio.mimeType);
  } catch {
    // The retrace still saves if the audio upload fails.
  }
  const aligned = await transcribeNarrationAudio(audio.base64, audio.mimeType, track.durationMs);
  const mapped = narrationFromTranscribeResult(true, aligned);
  const withAudio: RecordedTrack = {
    ...track,
    ...(audioUrl ? { audioUrl } : {}),
    ...(mapped.published?.spans?.length ? { narration: mapped.published.spans } : {}),
  };
  return {
    track: withAudio,
    transcript: mapped.published?.transcript ?? "",
    published: mapped.published
      ? {
          transcript: mapped.published.transcript ?? "",
          spans: mapped.published.spans ?? [],
          alignment: mapped.published.alignment === "estimated" ? "estimated" : "proportional",
        }
      : null,
    gap: mapped.gap === "none" ? "none" : mapped.gap,
  };
}

/**
 * One-take save: optional mic, then a Teach-ready finding. Speech-to-text
 * failure, a silent mic, and a short track all return a guide built from the
 * gestures plus the written notes.
 */
export async function assembleRecordedFinding<T extends Partial<Finding>>(
  base: T,
  track: RecordedTrack,
  audio: { base64: string; mimeType: string } | null | undefined,
  liveMeasurements?: FindingMeasurement[]
): Promise<{ finding: T; receipt: RecordedSaveReceipt }> {
  const attached = await attachTakeAudio(track, audio);
  const description = base.description?.trim() || attached.transcript || "";
  const drafted = { ...base, description };
  return commitRecordedFinding(
    drafted,
    attached.track,
    {
      label: drafted.label,
      description,
      teachingPoints: drafted.teachingPoints,
      take: attached.published
        ? {
            transcript: attached.published.transcript,
            spans: attached.published.spans,
            alignment: attached.published.alignment,
          }
        : { gap: attached.gap === "none" ? "empty-transcript" : attached.gap },
    },
    liveMeasurements
  );
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
