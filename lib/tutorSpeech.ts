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
// Socratic and viva do not use that name on a partial answer. Successive
// partials on the SAME finding climb one ladder: look-cue, then one region
// or landmark from that finding's description (diagnosis removed, search
// instructions dropped), then one mimic contrast, then the diagnosis label
// and one pearl. A search-step title ("Lung window — start mid-chest") is
// not the label, and a search-pattern prompt is not the pearl. Give-up,
// show me, a correct name, or both content hints already given jump to the
// reveal. A non-empty model line that misses the rung is replaced. The
// words come from the authored finding. Guided teach is unchanged.

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
  /** Finding this turn was about. Other findings do not climb this ladder. */
  findingId?: string;
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
  "mediastinal",
  "mediastinum",
]);

/**
 * Method words that show up in search-step labels ("Lung window", "nodule
 * survey"). They are not the diagnosis, so a search line that says "window"
 * must not reset the ladder or count as a reveal.
 */
const NOT_DIAGNOSIS = new Set([
  "window",
  "windows",
  "start",
  "survey",
  "search",
  "pattern",
  "slice",
  "slices",
  "pass",
  "reading",
  "image",
  "study",
  "series",
  "first",
  "level",
  "width",
  "center",
  "narrow",
  "approx",
]);

/** Mimic-versus-finding lines. A search instruction ("do not chase") is not one. */
const MIMIC_LINE =
  /\b(versus|vs\.?|rather than|instead of|mimic|pitfall|not a|not an|distinguish|could be|may be|mistake|confused with|differential|do not call|don't call|dont call|never call|do not mistake|don't mistake)\b/i;

const GENERIC_LOCATION = "Where would you look on this slice?";
const GENERIC_MIMIC = "What would you mistake this for?";

function diagnosisTokens(label: string): string[] {
  return label
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => {
      const lower = word.toLowerCase();
      return word.length >= 5 && !LOCATION_WORDS.has(lower) && !NOT_DIAGNOSIS.has(lower);
    });
}

function containsToken(text: string, token: string): boolean {
  return new RegExp(`\\b${escapeReg(token)}\\b`, "i").test(text);
}

/**
 * A method title ("Lung window — start mid-chest", "Mediastinal window pass")
 * has no diagnosis token. Saying it is not naming the finding.
 */
export function isSearchStepTitle(label: string): boolean {
  const trimmed = label.replace(/[.!?]+$/g, "").trim();
  if (!trimmed) return false;
  if (diagnosisTokens(trimmed).length > 0) return false;
  return /\b(windows?|survey|search|scroll|start|pass)\b/i.test(trimmed);
}

/** True when the text says this finding's name, not merely its side or lobe. */
export function namesDiagnosis(text: string, label: string): boolean {
  const phrase = label.trim();
  if (!phrase || isSearchStepTitle(phrase)) return false;
  if (phrase.length >= 4 && text.toLowerCase().includes(phrase.toLowerCase())) return true;
  return diagnosisTokens(phrase).some((token) => containsToken(text, token));
}

function isOpening(question: string): boolean {
  return !question.trim() || OPENING.test(question);
}

function priorPartialAttempts(
  history: readonly SpokenTurn[] | undefined,
  findings: readonly SpokenFindingSource[],
  currentFindingId?: string
): number {
  const current = currentFindingId
    ? findings.find((finding) => finding.id === currentFindingId)
    : undefined;
  const labels = findings.map((finding) => finding.label).filter(Boolean);
  let count = 0;
  for (const turn of history ?? []) {
    // A turn tagged to another finding does not climb, or reset, this one.
    if (currentFindingId && turn.findingId && turn.findingId !== currentFindingId) continue;
    const text = turn.text ?? "";
    const named = turn.findingId
      ? Boolean(current?.label && namesDiagnosis(text, current.label))
      : labels.some((label) => label && namesDiagnosis(text, label));
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
 * History must exclude the current question. 0 look, 1 location, 2 mimic,
 * 3 label + pearl. The count is partial answers on this finding only.
 * An assistant reveal of the diagnosis resets it. Give-up, show me, and a
 * correct name are level 3 even on the first turn.
 */
export function examHintLevel(input: {
  mode: TeachingMode;
  question: string;
  finding?: SpokenFindingSource;
  findings?: readonly SpokenFindingSource[];
  history?: readonly SpokenTurn[];
  currentFindingId?: string;
}): ExamHintLevel {
  if (input.mode !== "socratic" && input.mode !== "viva") return 3;
  const list = input.findings?.length ? [...input.findings] : input.finding ? [input.finding] : [];
  const currentId = input.currentFindingId ?? input.finding?.id;
  const current =
    (currentId ? list.find((finding) => finding.id === currentId) : undefined) ?? input.finding;
  const label = current?.label ?? "";
  if (GIVE_UP.test(input.question) || (label && namesDiagnosis(input.question, label))) {
    return 3;
  }
  if (isOpening(input.question)) return 0;
  const prior = priorPartialAttempts(input.history, list, currentId);
  if (prior <= 0) return 0;
  if (prior === 1) return 1;
  if (prior === 2) return 2;
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
    currentFindingId: opts?.finding?.id,
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

function isMimicSentence(sentence: string): boolean {
  return MIMIC_LINE.test(sentence);
}

/** How-to-look copy. A place named inside it is not yet the location line. */
const SEARCH_METHOD =
  /\b(scroll(?:ing)?|windows?|survey(?:ed|ing)?|search(?:ing)?|begin at|start at|search pattern)\b/i;

function isSearchInstruction(sentence: string): boolean {
  return SEARCH_METHOD.test(sentence);
}

/** "Name your search pattern before you scroll…" is not a reporting pearl. */
function isSearchPatternPrompt(sentence: string): boolean {
  return /\b(search pattern|name your search|before you scroll|lobe-by-lobe|lobes first|systematic lobe)\b/i.test(
    sentence
  );
}

const REGION_WORD =
  /^(apex|apices|apical|base|bases|basal|hilum|hila|hilar|fissure|lobe|lobes|segment|segments|periphery|peripheral|mediastinum|mediastinal|pleura|pleural|upper|lower|right|left|anterior|posterior|medial|lateral|bilateral|central|costophrenic|hemithorax|lingula|lung|lungs|chest)$/i;

function bareWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function regionScore(sentence: string): number {
  return sentence.split(/\s+/).filter((word) => REGION_WORD.test(bareWord(word))).length;
}

function leadCap(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** The place inside a search sentence, without the scroll or window verbs. */
function distillRegion(sentence: string): string {
  const clauses = sentence.split(/\s*(?:,|;|—|–|\band\b)\s*/i);
  let best = "";
  let bestScore = 0;
  for (const raw of clauses) {
    if (/\b(begin|start)\s+at\b/i.test(raw)) continue;
    let text = raw.replace(/\([^)]*\)/g, " ");
    text = text.replace(/\blung\s+windows?\b/gi, " ");
    text = text.replace(
      /\b(scroll(?:ing)?|windows?|survey(?:ed|ing)?|search(?:ing)?|scrutinise|scrutinize)\b/gi,
      " "
    );
    text = text.replace(/\b(set|use|switch|narrow|approx|width|center|level)\b/gi, " ");
    text = text.replace(/\b[WL]\s*\d+/gi, " ");
    text = text.replace(/[^A-Za-z0-9\s'-]/g, " ").replace(/\s+/g, " ").trim();
    text = text.replace(/^(and|then|on|the|a|an|of|for)\s+/i, "").trim();
    const words = text.split(/\s+/).filter(Boolean);
    const idx = words.findIndex((word) => REGION_WORD.test(bareWord(word)));
    if (idx < 0) continue;
    let start = idx;
    const prev = bareWord(words[idx - 1] ?? "");
    if (
      idx > 0 &&
      /^(both|the|each|right|left|upper|lower|bilateral|medial|lateral|anterior|posterior)$/.test(prev)
    ) {
      start = idx - 1;
    }
    let end = idx;
    for (let i = idx + 1; i < words.length; i++) {
      const word = bareWord(words[i] ?? "");
      if (REGION_WORD.test(word) || /^(and|of|the|both)$/.test(word)) {
        end = i;
        continue;
      }
      break;
    }
    const phrase = words.slice(start, end + 1).join(" ");
    const score = regionScore(phrase);
    if (score > bestScore && phrase.length >= 4) {
      best = phrase;
      bestScore = score;
    }
  }
  return best;
}

function hintSentence(
  sentence: string,
  label: string,
  ids: string[],
  labels: readonly string[]
): string {
  if (usableHint(sentence, labels)) return sentence;
  const redacted = tidy(redactDiagnosis(sentence, label), ids);
  return usableHint(redacted, labels) ? redacted : "";
}

function placeFromSentence(
  sentence: string,
  label: string,
  ids: string[],
  labels: readonly string[]
): string {
  const hinted = hintSentence(sentence, label, ids, labels);
  if (!hinted || isMimicSentence(hinted) || isSearchPatternPrompt(hinted)) return "";
  if (!isSearchInstruction(hinted) && regionScore(hinted) > 0) return hinted;
  if (!isSearchInstruction(hinted)) return "";
  const region = distillRegion(hinted);
  if (!region) return "";
  const redacted = tidy(redactDiagnosis(region, label), ids);
  if (!redacted || mentionsAnyDiagnosis(redacted, labels) || regionScore(redacted) === 0) return "";
  return leadCap(redacted);
}

/**
 * Level 1 — one region or landmark from this finding's description.
 * Diagnosis words are dropped. A scroll, window, survey, or "begin at the
 * carina" instruction is not the line; the place inside it is.
 * Nothing is added that the author didn't write.
 */
function locationHint(
  finding: SpokenFindingSource | undefined,
  ids: string[],
  labels: readonly string[]
): string {
  if (!finding) return GENERIC_LOCATION;
  const label = finding.label ?? "";
  const describe = sentencesOf(finding.description ?? "", ids)
    .map((sentence) => placeFromSentence(sentence, label, ids, labels))
    .filter(Boolean);
  const clean = describe.filter((sentence) => !isSearchInstruction(sentence));
  const ranked = (sentences: string[]) =>
    [...sentences].sort((a, b) => regionScore(b) - regionScore(a))[0];
  const best = ranked(clean) ?? ranked(describe);
  return best ? ensurePeriod(best) : GENERIC_LOCATION;
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
    .filter((sentence) => isMimicSentence(sentence));
  for (const sentence of contrasts) {
    const line = hintSentence(sentence, label, ids, labels);
    if (line) return ensurePeriod(line);
  }
  return GENERIC_MIMIC;
}

function diagnosisLabel(finding: SpokenFindingSource | undefined, ids: string[]): string {
  const label = tidy(finding?.label ?? "", ids);
  if (!label || isSearchStepTitle(label)) return "";
  return label;
}

/** One teaching point that is not a search-step title or a search-pattern prompt. */
function pearlLine(finding: SpokenFindingSource | undefined, ids: string[]): string {
  if (!finding) return "";
  const points = (finding.teachingPoints ?? []).flatMap((point) => sentencesOf(point, ids));
  for (const sentence of points) {
    if (isSearchPatternPrompt(sentence) || isSearchStepTitle(sentence)) continue;
    return sentence;
  }
  for (const sentence of sentencesOf(finding.description ?? "", ids)) {
    if (
      isSearchInstruction(sentence) ||
      isSearchPatternPrompt(sentence) ||
      isSearchStepTitle(sentence)
    ) {
      continue;
    }
    return sentence;
  }
  return "";
}

/** Level 3 — the diagnosis label, then one authored pearl. A method title is neither. */
function revealSentences(finding: SpokenFindingSource | undefined, ids: string[]): string[] {
  if (!finding) return [];
  const label = diagnosisLabel(finding, ids);
  const pearl = pearlLine(finding, ids);
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

const HINT_STOP = new Set([
  "this",
  "that",
  "with",
  "from",
  "your",
  "have",
  "been",
  "they",
  "them",
  "what",
  "when",
  "then",
  "into",
  "over",
  "under",
  "both",
  "until",
  "before",
  "after",
  "about",
  "there",
  "where",
  "look",
  "here",
  "slice",
  "watch",
  "follow",
  "would",
  "could",
  "should",
  "through",
  "their",
  "which",
]);

function contentWords(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !HINT_STOP.has(word));
}

/** True when the model already said this rung's authored line. */
function coversHint(answer: string, hint: string): boolean {
  const folded = hint.trim().toLowerCase().replace(/[.!?]+$/g, "");
  if (folded.length >= 12 && answer.toLowerCase().includes(folded)) return true;
  const words = contentWords(hint);
  if (words.length === 0) return folded.length > 0 && answer.toLowerCase().includes(folded);
  const hay = answer.toLowerCase();
  const hit = words.filter((word) => new RegExp(`\\b${escapeReg(word)}\\b`).test(hay));
  const need = words.length <= 2 ? words.length : Math.ceil(words.length * 0.5);
  return hit.length >= need;
}

function examLadderSpeech(
  input: EnsureSpokenInput,
  level: ExamHintLevel,
  finding: SpokenFindingSource | undefined,
  ids: string[],
  labels: readonly string[]
): string {
  const terms = authoredTerms(finding, ids);
  const cues =
    input.actions.length > 0
      ? input.actions.map((action, index) => pickCue(action.type, index, terms))
      : [pickCue("show_finding", 0, terms)];
  return joinSpeech([...cues, ...examTail(level, finding, ids, labels)]);
}

/** Look-cues aside, every remaining sentence is search copy. */
function searchCopyOnly(text: string): boolean {
  const body = splitSentences(text).filter((sentence) => !LOOK_CUE.test(sentence.trim()));
  const meaningful = body.filter((sentence) => !/^what do you see\??$/i.test(sentence.trim()));
  if (meaningful.length === 0) return false;
  return meaningful.every(
    (sentence) =>
      isSearchInstruction(sentence) ||
      isSearchPatternPrompt(sentence) ||
      isSearchStepTitle(sentence)
  );
}

/**
 * The exam speaks about the finding the student is on. A tool aimed at a
 * search step must not retarget the ladder or the spoken line.
 */
function resolveExamFinding(
  findings: SpokenFindingSource[],
  actions: SpokenAction[],
  currentFindingId?: string
): SpokenFindingSource | undefined {
  if (currentFindingId) {
    const active = orderedFindings(findings).find((finding) => finding.id === currentFindingId);
    if (active) return active;
  }
  return resolveFinding(findings, actions, currentFindingId);
}

/**
 * A model line may stay only when it already satisfies this rung.
 * Levels 0–2 must not name the finding, and must not be a search instruction
 * standing in for the location. Level 3 must say the diagnosis label (when
 * the author wrote one) and one pearl that is not a search-pattern prompt.
 */
function examRungSatisfied(
  text: string,
  level: ExamHintLevel,
  finding: SpokenFindingSource | undefined,
  ids: string[],
  labels: readonly string[]
): boolean {
  const label = diagnosisLabel(finding, ids);
  const named = Boolean(label) && namesDiagnosis(text, label);
  if (level >= 3) {
    const pearl = pearlLine(finding, ids);
    if (label && !named) return false;
    if (pearl && !coversHint(text, pearl)) return false;
    if (!label && !pearl) return !searchCopyOnly(text);
    return true;
  }
  if (named) return false;
  if (searchCopyOnly(text)) return false;
  if (level <= 0) return true;
  if (level === 1) return coversHint(text, locationHint(finding, ids, labels));
  return coversHint(text, discriminateHint(finding, ids, labels));
}

function ensureExamSpoken(input: EnsureSpokenInput, original: string): string {
  const ids = input.findings.map((finding) => finding.id);
  const finding = resolveExamFinding(input.findings, input.actions, input.currentFindingId);
  const labels = input.findings.map((item) => item.label).filter(Boolean);
  const level = examHintLevel({
    mode: input.mode,
    question: input.question,
    finding,
    findings: input.findings,
    history: input.history,
    currentFindingId: input.currentFindingId ?? finding?.id,
  });
  const ladder = examLadderSpeech(input, level, finding, ids, labels);
  if (!hasSpokenContent(original)) return ladder;
  if (examRungSatisfied(original, level, finding, ids, labels)) return original;
  return ladder;
}

const SEAT_ACTION = new Set([
  "show_finding",
  "play_guide",
  "point_to",
  "next_in_tour",
  "prev_in_tour",
  "scroll_to",
  "zoom_to",
]);

/** Level 3 with no viewer drive still seats the finding the student is on. */
export function seatExamReveal<T extends SpokenAction>(
  actions: readonly T[],
  level: ExamHintLevel,
  findingId?: string
): T[] {
  if (level < 3 || !findingId) return [...actions];
  if (actions.some((action) => SEAT_ACTION.has(action.type))) return [...actions];
  return [{ type: "show_finding", findingId } as T, ...actions];
}

/**
 * Keep a real guided answer. When tools fired and the message is empty, speak
 * look-cues first and the authored finding only after those cues.
 * Socratic and viva share examLadderSpeech, including when the model text
 * misses the rung for this finding.
 */
export function ensureSpokenAnswer(input: EnsureSpokenInput): string {
  const original = input.answer.replace(/\s+/g, " ").trim();
  if (input.mode === "socratic" || input.mode === "viva") {
    return ensureExamSpoken(input, original);
  }
  if (hasSpokenContent(original)) return original;

  const ids = input.findings.map((finding) => finding.id);
  const finding = resolveFinding(input.findings, input.actions, input.currentFindingId);
  const name = mayNameFinding(input.mode, input.question, input.actions, {
    finding,
    findings: input.findings,
    history: input.history,
  });

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
