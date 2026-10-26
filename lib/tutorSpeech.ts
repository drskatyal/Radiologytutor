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
//
// Socratic and viva do not use that name on a partial answer. The rung is
// look-cue, then a location line from the description, then one mimic line
// from the teaching points, then the label and one pearl. Give-up, show me,
// a correct name, or two hints already given jump to the reveal. The words
// come from the authored finding. Guided teach is unchanged.

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

export interface SpokenTurn {
  role: "user" | "assistant";
  text: string;
}

/** Socratic / viva rung. 0 look-cue, 1 location, 2 mimic, 3 label + pearl. */
export type ExamHintLevel = 0 | 1 | 2 | 3;

export interface EnsureSpokenInput {
  answer: string;
  mode: TeachingMode;
  question: string;
  actions: SpokenAction[];
  findings: SpokenFindingSource[];
  currentFindingId?: string;
  /**
   * Prior chat turns, excluding the current question. A partial answer
   * climbs the hint ladder; a reveal in an assistant turn resets it.
   */
  history?: readonly SpokenTurn[];
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

const GIVE_UP =
  /\b(don'?t know|do not know|no idea|show me|reveal|give up|gave up)\b/i;

const OPENING = /^\s*(begin the session|begin teaching)\b/i;

/** Laterality and place words are not the diagnosis. */
const LOCATION_WORDS = new Set([
  "right",
  "left",
  "upper",
  "lower",
  "apical",
  "basal",
  "medial",
  "lateral",
  "anterior",
  "posterior",
  "superior",
  "inferior",
  "bilateral",
  "peripheral",
  "central",
  "lobe",
  "lung",
  "chest",
  "small",
  "large",
  "solid",
  "acute",
  "chronic",
  "head",
  "neck",
  "side",
  "part",
  "soft",
  "tissue",
  "bone",
]);

/** Mimic-versus-finding lines. These are level 2, not the location hint. */
const DISCRIMINATE =
  /\b(do not|don't|dont|never|versus|vs\.?|rather than|instead of|instead|mimic|pitfall|not a|not an|until you|distinguish|compare|could be|may be|mistake)\b/i;

const GENERIC_LOCATION = "Where would you look on this slice?";
const GENERIC_MIMIC = "What would you mistake this for?";

/** A teaching point that tells the student where to search, not a reporting pearl. */
const SEARCH_HINT =
  /\b(scroll|window|search|look|survey|periphery|slice|apex|lobe|begin|start|carina|edge|border|line|contour|opacity|where|level)\b/i;

function diagnosisTokens(label: string): string[] {
  return label
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 5 && !LOCATION_WORDS.has(word.toLowerCase()));
}

function containsToken(text: string, token: string): boolean {
  return new RegExp(`\\b${escapeReg(token)}\\b`, "i").test(text);
}

/** True when the text says this finding's name, not merely its side or lobe. */
export function namesDiagnosis(text: string, label: string): boolean {
  const phrase = label.trim();
  if (phrase.length >= 4 && text.toLowerCase().includes(phrase.toLowerCase())) return true;
  return diagnosisTokens(phrase).some((token) => containsToken(text, token));
}

function isOpening(question: string): boolean {
  return !question.trim() || OPENING.test(question);
}

function priorPartialAttempts(
  history: readonly SpokenTurn[] | undefined,
  labels: readonly string[]
): number {
  let count = 0;
  for (const turn of history ?? []) {
    const text = turn.text ?? "";
    const named = labels.some((label) => label && namesDiagnosis(text, label));
    if (turn.role === "assistant") {
      if (named) count = 0;
      continue;
    }
    if (isOpening(text) || GIVE_UP.test(text) || named) {
      count = 0;
      continue;
    }
    if (text.trim()) count += 1;
  }
  return count;
}

/**
 * Socratic and viva rung for this student turn.
 * History must exclude the current question. Naming any authored diagnosis,
 * or an assistant reveal, resets the count so the next finding starts again.
 */
export function examHintLevel(input: {
  mode: TeachingMode;
  question: string;
  finding?: SpokenFindingSource;
  findings?: readonly SpokenFindingSource[];
  history?: readonly SpokenTurn[];
}): ExamHintLevel {
  if (input.mode !== "socratic" && input.mode !== "viva") return 3;
  const labels = (input.findings?.length ? input.findings : input.finding ? [input.finding] : [])
    .map((finding) => finding.label)
    .filter(Boolean);
  const current = input.finding?.label ?? "";
  if (GIVE_UP.test(input.question) || (current && namesDiagnosis(input.question, current))) {
    return 3;
  }
  if (isOpening(input.question)) return 0;
  const prior = priorPartialAttempts(input.history, labels);
  if (prior <= 0) return 1;
  if (prior === 1) return 2;
  return 3;
}

/** Exam modes hide the diagnosis until give-up, a correct name, or two hints. */
export function mayNameFinding(
  mode: TeachingMode,
  question: string,
  _actions: SpokenAction[],
  opts?: {
    finding?: SpokenFindingSource;
    findings?: readonly SpokenFindingSource[];
    history?: readonly SpokenTurn[];
  }
): boolean {
  if (mode === "guided" || mode === "reporting" || mode === "free") return true;
  return (
    examHintLevel({
      mode,
      question,
      finding: opts?.finding,
      findings: opts?.findings,
      history: opts?.history,
    }) >= 3
  );
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

function sentencesOf(text: string, ids: string[]): string[] {
  const cleaned = tidy(text, ids);
  if (!cleaned) return [];
  return splitSentences(cleaned)
    .map((sentence) => tidy(sentence, ids))
    .filter(Boolean);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length;
}

function redactDiagnosis(text: string, label: string): string {
  let out = text;
  const phrase = label.trim();
  if (phrase.length >= 4) {
    out = out.replace(new RegExp(escapeReg(phrase), "ig"), " ");
  }
  for (const token of diagnosisTokens(phrase)) {
    out = out.replace(new RegExp(`\\b(a|an|the)\\s+${escapeReg(token)}\\w*\\b`, "ig"), " ");
    out = out.replace(new RegExp(`\\b${escapeReg(token)}\\w*\\b`, "ig"), " ");
  }
  out = out.replace(/\s+/g, " ").replace(/\s+([.!?])/g, "$1").replace(/\s+,/g, ",").trim();
  out = out.replace(/[, ]*\bnot\b\s*[.!?]?$/i, "").trim();
  out = out.replace(/^(and|or|a|an|the)\s+/i, "").trim();
  return out.replace(/\s+/g, " ").trim();
}

function mentionsAnyDiagnosis(text: string, labels: readonly string[]): boolean {
  return labels.some((label) => label && namesDiagnosis(text, label));
}

function usableHint(sentence: string, labels: readonly string[]): boolean {
  return Boolean(sentence) && !mentionsAnyDiagnosis(sentence, labels) && wordCount(sentence) >= 3;
}

/**
 * Level 1 — where to look, from the description or a search teaching point.
 * Diagnosis words are dropped. A reporting pearl is not a location hint.
 * Nothing is added that the author didn't write.
 */
function locationHint(
  finding: SpokenFindingSource | undefined,
  ids: string[],
  labels: readonly string[]
): string {
  if (!finding) return GENERIC_LOCATION;
  const label = finding.label ?? "";
  const description = sentencesOf(finding.description ?? "", ids);
  const searchPoints = (finding.teachingPoints ?? [])
    .flatMap((point) => sentencesOf(point, ids))
    .filter((sentence) => !DISCRIMINATE.test(sentence) && SEARCH_HINT.test(sentence));
  for (const sentence of description) {
    if (usableHint(sentence, labels)) return ensurePeriod(sentence);
  }
  for (const sentence of searchPoints) {
    if (usableHint(sentence, labels)) return ensurePeriod(sentence);
  }
  for (const sentence of [...description, ...searchPoints]) {
    const redacted = tidy(redactDiagnosis(sentence, label), ids);
    if (usableHint(redacted, labels)) return ensurePeriod(redacted);
  }
  return GENERIC_LOCATION;
}

/** Level 2 — mimic versus finding, only from teaching points. */
function discriminateHint(
  finding: SpokenFindingSource | undefined,
  ids: string[],
  labels: readonly string[]
): string {
  if (!finding) return GENERIC_MIMIC;
  const label = finding.label ?? "";
  const contrasts = (finding.teachingPoints ?? [])
    .flatMap((point) => sentencesOf(point, ids))
    .filter((sentence) => DISCRIMINATE.test(sentence));
  for (const sentence of contrasts) {
    if (usableHint(sentence, labels)) return ensurePeriod(sentence);
  }
  for (const sentence of contrasts) {
    const redacted = tidy(redactDiagnosis(sentence, label), ids);
    if (usableHint(redacted, labels)) return ensurePeriod(redacted);
  }
  return GENERIC_MIMIC;
}

/** Level 3 — the label, then one authored pearl. */
function revealSentences(finding: SpokenFindingSource | undefined, ids: string[]): string[] {
  if (!finding) return [];
  const label = tidy(finding.label, ids);
  const pearl =
    (finding.teachingPoints ?? []).flatMap((point) => sentencesOf(point, ids)).find(Boolean) ??
    sentencesOf(finding.description ?? "", ids)[0] ??
    "";
  const out: string[] = [];
  if (label) out.push(ensurePeriod(label));
  if (pearl && pearl.toLowerCase() !== label.toLowerCase()) out.push(ensurePeriod(pearl));
  return out;
}

function examTail(
  level: ExamHintLevel,
  finding: SpokenFindingSource | undefined,
  ids: string[],
  labels: readonly string[]
): string[] {
  if (level === 0) return ["What do you see?"];
  if (level === 1) return [locationHint(finding, ids, labels)];
  if (level === 2) return [discriminateHint(finding, ids, labels)];
  return revealSentences(finding, ids);
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
  const exam = input.mode === "socratic" || input.mode === "viva";
  const level = exam
    ? examHintLevel({
        mode: input.mode,
        question: input.question,
        finding,
        findings: input.findings,
        history: input.history,
      })
    : 3;
  const labels = input.findings.map((item) => item.label).filter(Boolean);
  const name = exam
    ? level >= 3
    : mayNameFinding(input.mode, input.question, input.actions, {
        finding,
        findings: input.findings,
        history: input.history,
      });

  if (input.actions.length > 0) {
    const terms = authoredTerms(finding, ids);
    const cues = input.actions.map((action, index) => pickCue(action.type, index, terms));
    const tail = exam
      ? examTail(level, finding, ids, labels)
      : name
        ? authoredSentences(finding, ids)
        : ["What do you see?"];
    return joinSpeech([...cues, ...tail]);
  }

  if (exam && level >= 1) {
    const terms = authoredTerms(finding, ids);
    return joinSpeech([
      pickCue("show_finding", 0, terms),
      ...examTail(level, finding, ids, labels),
    ]);
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
