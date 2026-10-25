// Spoken-answer contract for the live tutor.
//
// Gemini sometimes returns viewer tool calls and an empty message. The student
// then sees a moving scan, a blank Discussion, and a Teach tour that waits
// forever on speech onEnd. This module fills that hole from authored finding
// text only — it never invents anatomy.
//
// Drive-first (docs/TUTOR_EVAL.md): one unlabeled look-cue per tool, then the
// name. buildPerformancePlan puts action i on sentence i and the scorer applies
// that action after the sentence, so the label must sit on a later sentence.

import { splitSentences } from "./performancePlan";
import type { TeachingMode } from "./teachingPrompt";

export interface SpokenFindingSource {
  id: string;
  label: string;
  description?: string;
  teachingPoints?: string[];
  order?: number;
}

export interface SpokenAction {
  type: string;
  findingId?: string;
}

export interface EnsureSpokenInput {
  answer: string;
  mode: TeachingMode;
  question: string;
  actions: SpokenAction[];
  findings: SpokenFindingSource[];
  currentFindingId?: string;
  /**
   * The client already revealed this finding before asking the tutor
   * (guided auto-seat). A name is then allowed after a single look-cue.
   */
  viewerAlreadySeated?: boolean;
}

export interface TutorSpeechPlan extends EnsureSpokenInput {
  /** Guided tour is still running. Empty audio must advance it. */
  tourActive: boolean;
}

const REVEAL_TOOLS = new Set([
  "show_finding",
  "point_to",
  "play_guide",
  "next_in_tour",
  "prev_in_tour",
  "draw_annotation",
]);

/** Preferred look-cue per tool. Replaced when it would speak an authored term. */
const CUE_FOR_TOOL: Record<string, string> = {
  set_window: "Watch the window.",
  set_invert: "Watch the window.",
  zoom_to: "See this closer.",
  set_zoom: "See this closer.",
  point_to: "Follow the pointer.",
  draw_annotation: "Follow the pointer.",
  scroll_to: "Watch the stack.",
  show_finding: "Look at this slice.",
  play_guide: "Look at this slice.",
  next_in_tour: "Look at this slice.",
  prev_in_tour: "Look at this slice.",
};

/** No word of 5+ letters, so these cannot name a finding. */
const SAFE_CUES = ["Look here.", "See here.", "Watch here.", "Follow here."];

const LOOK_CUE = /^(look|see|watch|follow)\b/i;

function hasSpokenContent(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}

function escapeReg(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensurePeriod(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function tidy(text: string, ids: string[]): string {
  let out = text.replace(/\s+/g, " ").trim();
  if (!out || out.toLowerCase() === "(untitled)") return "";
  for (const id of ids) {
    if (!id || id.length < 2) continue;
    out = out.replace(new RegExp(`\\b${escapeReg(id)}\\b`, "g"), "");
  }
  out = out.replace(/\b0\.\d{2,}\b/g, "");
  out = out.replace(/\b(sliceIndex|windowWidth|windowCenter|findingId)\b/g, "");
  out = out.replace(/\s+/g, " ").replace(/\s+([.!?])/g, "$1").trim();
  return out;
}

function orderedFindings(findings: SpokenFindingSource[]): SpokenFindingSource[] {
  return [...findings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function resolveFinding(
  findings: SpokenFindingSource[],
  actions: SpokenAction[],
  currentFindingId?: string
): SpokenFindingSource | undefined {
  const ordered = orderedFindings(findings);
  const targeted = [...actions].reverse().find((action) => action.findingId)?.findingId;
  if (targeted) {
    const hit = ordered.find((finding) => finding.id === targeted);
    if (hit) return hit;
  }
  const currentIdx = currentFindingId
    ? ordered.findIndex((finding) => finding.id === currentFindingId)
    : -1;
  if (actions.some((action) => action.type === "next_in_tour") && currentIdx >= 0) {
    return ordered[currentIdx + 1] ?? ordered[currentIdx];
  }
  if (actions.some((action) => action.type === "prev_in_tour") && currentIdx >= 0) {
    return ordered[Math.max(0, currentIdx - 1)];
  }
  if (currentIdx >= 0) return ordered[currentIdx];
  return ordered[0];
}

/** Exam modes hide the diagnosis until the student has tried or asked. */
export function mayNameFinding(
  mode: TeachingMode,
  question: string,
  actions: SpokenAction[]
): boolean {
  if (mode === "guided" || mode === "reporting" || mode === "free") return true;
  if (/\b(don'?t know|do not know|show me|reveal)\b/i.test(question)) return true;
  const opening =
    !question.trim() ||
    /^\s*begin the session\b/i.test(question) ||
    /^\s*begin teaching\b/i.test(question);
  if (opening) return false;
  return actions.some((action) => REVEAL_TOOLS.has(action.type));
}

function authoredTerms(finding: SpokenFindingSource | undefined, ids: string[]): string[] {
  if (!finding) return [];
  const blob = tidy(
    [finding.label, finding.description ?? "", ...(finding.teachingPoints ?? [])].join(" "),
    ids
  );
  return blob
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 5);
}

function overlapsAuthored(cue: string, terms: string[]): boolean {
  return terms.some((term) => new RegExp(`\\b${escapeReg(term)}\\w*`, "i").test(cue));
}

function pickCue(type: string, index: number, terms: string[]): string {
  const preferred = CUE_FOR_TOOL[type] ?? "Look at this slice.";
  if (LOOK_CUE.test(preferred) && !overlapsAuthored(preferred, terms)) return preferred;
  const safe = SAFE_CUES[index % SAFE_CUES.length] ?? "Look here.";
  if (!overlapsAuthored(safe, terms)) return safe;
  return "Look here.";
}

function authoredSentences(finding: SpokenFindingSource | undefined, ids: string[]): string[] {
  if (!finding) return [];
  const label = tidy(finding.label, ids);
  const description = tidy(finding.description ?? "", ids);
  const pearl = tidy(
    (finding.teachingPoints ?? []).map((point) => point.trim()).find(Boolean) ?? "",
    ids
  );
  const descriptionFirst = splitSentences(description)[0] ?? "";
  const pearlFirst = splitSentences(pearl)[0] ?? "";
  const out: string[] = [];
  const later = `${descriptionFirst} ${pearlFirst}`.toLowerCase();
  if (label && !later.includes(label.toLowerCase())) out.push(ensurePeriod(label));
  if (descriptionFirst) out.push(ensurePeriod(descriptionFirst));
  if (pearlFirst && pearlFirst.toLowerCase() !== descriptionFirst.toLowerCase()) {
    out.push(ensurePeriod(pearlFirst));
  }
  return out.filter(Boolean);
}

function impressionLine(findings: SpokenFindingSource[], ids: string[]): string {
  const labels = orderedFindings(findings)
    .map((finding) => tidy(finding.label, ids))
    .filter(Boolean)
    .map(ensurePeriod);
  if (labels.length === 0) return "Look here.";
  return ["Look here.", ...labels].join(" ");
}

function joinSpeech(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}

/**
 * Keep a real answer. When tools fired and the message is empty, speak
 * look-cues first and the authored finding only after those cues.
 */
export function ensureSpokenAnswer(input: EnsureSpokenInput): string {
  const original = input.answer.replace(/\s+/g, " ").trim();
  if (hasSpokenContent(original)) return original;

  const ids = input.findings.map((finding) => finding.id);
  const finding = resolveFinding(input.findings, input.actions, input.currentFindingId);
  const name = mayNameFinding(input.mode, input.question, input.actions);

  if (input.actions.length > 0) {
    const terms = authoredTerms(finding, ids);
    const cues = input.actions.map((action, index) => pickCue(action.type, index, terms));
    const tail = name ? authoredSentences(finding, ids) : ["What do you see?"];
    return joinSpeech([...cues, ...tail]);
  }

  if (
    (input.mode === "guided" || input.mode === "reporting") &&
    /\bimpression\b/i.test(input.question)
  ) {
    return impressionLine(input.findings, ids);
  }

  if (input.viewerAlreadySeated && name) {
    const terms = authoredTerms(finding, ids);
    return joinSpeech([
      pickCue("show_finding", 0, terms),
      ...authoredSentences(finding, ids),
    ]);
  }

  return "";
}

export interface TutorSpeechDecision {
  /** Text to show and send to /api/tts. Empty only when there is nothing safe to say. */
  answer: string;
  /** Speak `answer` (and let the tour advance from speech onEnd). */
  speak: boolean;
  /** Guided tour has no line to wait on — advance instead of soft-locking. */
  advanceWithoutSpeech: boolean;
}

/** What the student client should do with one tutor payload. */
export function tutorSpeechPlan(input: TutorSpeechPlan): TutorSpeechDecision {
  const answer = ensureSpokenAnswer(input).trim();
  const speak = hasSpokenContent(answer);
  return {
    answer: speak ? answer : "",
    speak,
    advanceWithoutSpeech: !speak && input.tourActive && input.mode === "guided",
  };
}

/** Floor so a short look-cue still has time to start. */
export const NARRATION_HOLD_MIN_MS = 2_000;
/**
 * Ceiling for one beat. A dead fetch, a clip that never fires `ended`, or a
 * long pearl must not freeze the next gesture or the next finding.
 */
export const NARRATION_HOLD_MAX_MS = 12_000;

/**
 * How long Teach waits for the first audio sample. A slow fetch or a clip
 * that never starts must not sit in silence for the whole narration hold.
 * Once audio is playing, the hold above still lets a real pearl finish.
 */
export const TTS_START_BUDGET_MS = 2_500;

/**
 * How long Teach may wait on one spoken line before the next beat runs.
 * Blank text waits nothing. Otherwise ~14 characters/second plus a short
 * lead-in, clamped so TTS failure cannot soft-lock the tour.
 */
export function narrationHoldMs(text: string): number {
  const chars = text.trim().length;
  if (chars === 0) return 0;
  const estimated = Math.round((chars / 14) * 1000) + 1_500;
  return Math.min(NARRATION_HOLD_MAX_MS, Math.max(NARRATION_HOLD_MIN_MS, estimated));
}

/**
 * Zero-length audio must not block Teach. Unknown duration (null) can block
 * until the element ends or the playback watchdog fires.
 */
export function speechAudioCanBlock(
  byteLength: number,
  durationSec: number | null | undefined
): boolean {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return false;
  if (durationSec === 0) return false;
  return true;
}
