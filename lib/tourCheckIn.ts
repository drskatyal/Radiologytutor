// Student check-in on the Teach tour.
//
// The attending pauses before a decision beat (the commit, unless the guide
// marks one) and asks a short text question. Options never carry image
// coordinates — the viewer stays on the anchor the script already drove.
// A correct answer affirms and drops the pearl. A miss or "Don't know"
// speaks a correction while the authored lean-in zoom runs again, then the
// reveal continues. Gemini may write the question; the fallback below is
// what plays when that call is missing or unusable, including the LIDC seed.

import type { TeachAct, TeachBeat, TeachViewerAction, TeachingGuide } from "./types";

export const DONT_KNOW_OPTION = "Don't know";

export type CheckInResult = "correct" | "wrong" | "unknown";

export interface TourCheckIn {
  findingId: string;
  /** Shown in the tutor rail. */
  prompt: string;
  /** Spoken line. Same words as the prompt — options are not read aloud. */
  say: string;
  options: string[];
  /** Index into `options`. Never the Don't-know choice. */
  correctIndex: number;
  affirm: string;
  correction: string;
}

export interface FindingCheckInState {
  findingId: string;
  result: CheckInResult;
  prompt: string;
}

/** What the player inserts before the decision beat, and which later acts to drop. */
export interface CheckInBranch {
  preface: TeachBeat[];
  skipActs: TeachAct[];
}

export interface CheckInCopy {
  affirm: string;
  correction: string;
}

/** Fields the question may be built from. Markers and labels are not read. */
export interface CheckInSource {
  id: string;
  label?: string;
  description?: string;
  teachingPoints?: string[];
  reportGold?: string;
  reportMustMention?: string[];
  teachingGuide?: { beats?: readonly { say?: string }[] };
}

export interface ActiveCheckIn {
  findingId: string;
  prompt: string;
  options: string[];
}

export const CHECK_IN_SYSTEM = `You are the attending on a radiology teach tour.
Ask one short question the registrar can answer from the supplied teaching text.
Return JSON only: {"prompt": string, "options": string[], "correctIndex": number, "affirm": string, "correction": string}.
options has 2 or 3 short text choices. correctIndex is the right one.
affirm is one sentence if they are right. correction is one or two sentences if they are wrong, and it teaches the point.
Do not include "Don't know". Do not include image coordinates, percentages, slice indexes, or the words click or pixel.
Do not name a finding the source text does not support.`;

const COORD_OR_CLICK = /\b(?:x_pct|y_pct|click|pixel|pixels)\b/i;
const UNIT_POINT = /\b0\.\d{2,}\b/;
const SLICE_NUMBER = /\bslice\s*\d+/i;

/** True when a line would aim the student at a coordinate or a click. */
export function leaksImageTarget(text: string): boolean {
  return COORD_OR_CLICK.test(text) || UNIT_POINT.test(text) || SLICE_NUMBER.test(text);
}

function isDontKnow(text: string): boolean {
  const value = text.trim().toLowerCase().replace(/['’]/g, "");
  return value === "dont know" || value === "i dont know" || value === "do not know";
}

function stableShift(text: string, n: number): number {
  if (n <= 1) return 0;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % n;
}

function assembleOptions(
  correct: string,
  distractors: readonly string[],
  salt: string
): { options: string[]; correctIndex: number } {
  const content: string[] = [];
  const push = (value: string) => {
    const text = value.trim().replace(/\s+/g, " ");
    if (!text || leaksImageTarget(text) || isDontKnow(text)) return;
    if (content.some((item) => item.toLowerCase() === text.toLowerCase())) return;
    content.push(text);
  };
  push(correct);
  for (const item of distractors) push(item);
  if (content.length < 2 || content[0] !== correct.trim().replace(/\s+/g, " ")) {
    return { options: [], correctIndex: -1 };
  }
  const body = content.slice(0, 3);
  const correctText = body[0];
  const shift = stableShift(salt, body.length);
  const rotated = body.slice(shift).concat(body.slice(0, shift));
  const correctIndex = rotated.indexOf(correctText);
  if (correctIndex < 0) return { options: [], correctIndex: -1 };
  return { options: [...rotated, DONT_KNOW_OPTION], correctIndex };
}

interface Pattern {
  test: (text: string) => boolean;
  prompt: string;
  correct: string;
  distractors: readonly string[];
  affirm: string;
  correction: string;
}

const PATTERNS: readonly Pattern[] = [
  {
    test: (text) => /solid\s+(?:vs\.?|versus|or)\s+subsolid/i.test(text),
    prompt: "Before you measure, how do you call the density?",
    correct: "Solid or subsolid",
    distractors: ["Millimetres first, density later", "Bone window, then measure"],
    affirm: "Good. Solid or subsolid, then you measure.",
    correction: "Call solid or subsolid before you put calipers on it. Look at the edge again.",
  },
  {
    test: (text) => /\blobes?\b/i.test(text),
    prompt: "Before you scroll, which lobe search are you naming?",
    correct: "Upper lobes first, or lobe by lobe",
    distractors: ["Mediastinum before either lung", "Bone window through the spine"],
    affirm: "Good. Name the lobes, then scroll.",
    correction:
      "Name the search first — upper lobes, or lobe by lobe — before you chase the mediastinum.",
  },
  {
    test: (text) => /\bnodule\b/i.test(text) && /\bvessel\b/i.test(text),
    prompt: "A round opacity that vanishes on the next slices is more likely which?",
    correct: "A vessel on end",
    distractors: ["A true nodule", "A calcified granuloma"],
    affirm: "Right. If it vanishes, think vessel on end.",
    correction:
      "If it disappears on the next slices, it may be a vessel on end. A nodule stays round.",
  },
  {
    test: (text) => /\bcarina\b/i.test(text) && /\b(?:both lungs|inferiorly)\b/i.test(text),
    prompt: "Where does this lung survey start, and which way do you scroll?",
    correct: "Carina, then inferiorly through both lungs",
    distractors: ["Mediastinum first, lungs after", "Apex only, on bone windows"],
    affirm: "Good. Carina, then down through both lungs.",
    correction:
      "Start at the carina and scroll inferiorly through both lungs before the mediastinum.",
  },
  {
    test: (text) => /\bgranulomas?\b/i.test(text) && /\b(?:impression|actionable)\b/i.test(text),
    prompt: "What does the impression have to separate?",
    correct: "Actionable nodules from calcified granulomas",
    distractors: ["Every nodule as a primary cancer", "Heart size from the aortic root"],
    affirm: "Good. Separate actionable nodules from calcified granulomas.",
    correction:
      "The impression separates actionable nodules from benign calcified granulomas.",
  },
];

const GENERIC_DISTRACTORS = [
  "Bone window through the spine only",
  "Measure before you decide the density",
  "Read the mediastinum before either lung",
  "Call every vessel on end a nodule",
];

/** Teaching text the question may quote. The label and the marker stay out. */
export function checkInSourceText(source: CheckInSource): string {
  const says = (source.teachingGuide?.beats ?? [])
    .map((beat) => beat.say?.trim() ?? "")
    .filter(Boolean);
  return [
    source.reportGold,
    source.description,
    ...(source.teachingPoints ?? []),
    ...(source.reportMustMention ?? []),
    ...says,
  ]
    .map((line) => (line ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function claimSentences(source: CheckInSource): string[] {
  const blob = [source.reportGold, source.description, ...(source.teachingPoints ?? [])]
    .map((line) => (line ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return blob
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().replace(/\s+/g, " "))
    .filter((sentence) => sentence.length >= 12 && !leaksImageTarget(sentence));
}

function clip(text: string, max = 96): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > 40 ? cut.slice(0, space) : cut).replace(/[,:;.\s]+$/, "");
}

function finish(
  source: CheckInSource,
  prompt: string,
  correct: string,
  distractors: readonly string[],
  affirm: string,
  correction: string
): TourCheckIn | null {
  const assembled = assembleOptions(correct, distractors, `${source.id}:${prompt}`);
  if (assembled.options.length < 3 || assembled.correctIndex < 0) return null;
  if (leaksImageTarget(prompt) || leaksImageTarget(affirm) || leaksImageTarget(correction)) {
    return null;
  }
  return {
    findingId: source.id,
    prompt,
    say: prompt,
    options: assembled.options,
    correctIndex: assembled.correctIndex,
    affirm,
    correction,
  };
}

/**
 * Deterministic question from the guide and the report gold. Null when the
 * finding has no teaching text safe to ask about. Used when Gemini is down
 * and as the floor under a rejected model payload.
 */
export function fallbackCheckIn(source: CheckInSource): TourCheckIn | null {
  const text = checkInSourceText(source);
  if (!text.trim()) return null;
  const pattern = PATTERNS.find((item) => item.test(text));
  if (pattern) {
    return finish(
      source,
      pattern.prompt,
      pattern.correct,
      pattern.distractors,
      pattern.affirm,
      pattern.correction
    );
  }
  const sentence = claimSentences(source)[0];
  if (!sentence) return null;
  const correct = clip(sentence);
  return finish(
    source,
    "Which line belongs in the report?",
    correct,
    GENERIC_DISTRACTORS,
    "Good. That's the line.",
    `Not that one. ${correct}`
  );
}

function cleanSpoken(value: unknown, fallback: string): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text && text.length <= 240 && !leaksImageTarget(text)) return text;
  if (!fallback || leaksImageTarget(fallback) || fallback.length > 240) return null;
  return fallback;
}

/**
 * Accept a model payload only when it is a text question with a real answer.
 * Coordinates, click instructions, and a correct "Don't know" are rejected
 * so the caller can use {@link fallbackCheckIn}.
 */
export function checkInFromModel(raw: unknown, findingId: string): TourCheckIn | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  if (prompt.length < 8 || prompt.length > 200 || leaksImageTarget(prompt)) return null;
  if (!Array.isArray(obj.options)) return null;
  const correctIndex = obj.correctIndex;
  if (typeof correctIndex !== "number" || !Number.isInteger(correctIndex)) return null;
  if (correctIndex < 0 || correctIndex >= obj.options.length) return null;
  const correctRaw = obj.options[correctIndex];
  if (typeof correctRaw !== "string") return null;
  const distractors = obj.options.filter(
    (item, index): item is string => index !== correctIndex && typeof item === "string"
  );
  const assembled = assembleOptions(correctRaw, distractors, `${findingId}:${prompt}`);
  if (assembled.options.length < 3 || assembled.correctIndex < 0) return null;
  const correctText = assembled.options[assembled.correctIndex] ?? "";
  const affirm = cleanSpoken(obj.affirm, `Good. ${correctText}.`);
  const correction = cleanSpoken(obj.correction, correctText);
  if (!affirm || !correction) return null;
  return {
    findingId,
    prompt,
    say: prompt,
    options: assembled.options,
    correctIndex: assembled.correctIndex,
    affirm,
    correction,
  };
}

/** Model payload when it is usable, otherwise the deterministic question. */
export function resolveCheckIn(source: CheckInSource, model: unknown): TourCheckIn | null {
  if (model != null && model !== "") {
    const parsed = checkInFromModel(model, source.id);
    if (parsed) return parsed;
  }
  return fallbackCheckIn(source);
}

export function checkInModelPrompt(source: CheckInSource): string {
  const lines = [
    "Write one check-in for this finding.",
    "Use only the text below. Do not invent coordinates, slice numbers, or click targets.",
  ];
  const label = source.label?.trim();
  if (label) lines.push(`Do not use this withheld label in the prompt or the options: ${label}`);
  lines.push("", checkInSourceText(source));
  return lines.join("\n");
}

/**
 * Ask the server for a question, then fall back locally. Never throws.
 * A 503, a rejected payload, or a missing network all return the same
 * deterministic question the tour can speak without a key.
 */
export async function loadTourCheckIn(
  source: CheckInSource,
  signal?: AbortSignal
): Promise<TourCheckIn | null> {
  const fallback = fallbackCheckIn(source);
  try {
    const res = await fetch("/api/tour-check-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        findingId: source.id,
        label: source.label,
        description: source.description,
        teachingPoints: source.teachingPoints,
        reportGold: source.reportGold,
        reportMustMention: source.reportMustMention,
        says: (source.teachingGuide?.beats ?? []).map((beat) => beat.say ?? ""),
      }),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { checkIn?: unknown };
    if (body?.checkIn == null) return fallback;
    return checkInFromModel(body.checkIn, source.id) ?? fallback;
  } catch {
    return fallback;
  }
}

export function gradeCheckIn(
  check: Pick<TourCheckIn, "options" | "correctIndex">,
  selectedIndex: number
): CheckInResult {
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= check.options.length) {
    return "unknown";
  }
  if (isDontKnow(check.options[selectedIndex] ?? "")) return "unknown";
  return selectedIndex === check.correctIndex ? "correct" : "wrong";
}

export function recordCheckIn(
  prev: readonly FindingCheckInState[],
  next: FindingCheckInState
): FindingCheckInState[] {
  return [...prev.filter((row) => row.findingId !== next.findingId), next];
}

/**
 * First beat marked `decision`, otherwise the commit. Null when the guide
 * has neither — the tour then stays on the script and does not invent a pause.
 */
export function decisionBeatIndex(guide: Pick<TeachingGuide, "beats">): number | null {
  const marked = guide.beats.findIndex((beat) => beat.decision === true);
  if (marked >= 0) return marked;
  const commit = guide.beats.findIndex((beat) => beat.act === "commit");
  return commit >= 0 ? commit : null;
}

function zoomBefore(
  guide: TeachingGuide,
  decisionIndex: number
): Extract<TeachViewerAction, { type: "zoom" }> | null {
  const end = Math.min(guide.beats.length, Math.max(0, decisionIndex));
  for (let i = end - 1; i >= 0; i--) {
    const beat = guide.beats[i];
    if (beat?.act !== "lean-in") continue;
    for (const action of beat.actions) {
      if (action.type === "zoom") return action;
    }
  }
  return null;
}

/**
 * What plays after the answer, before and instead of the remaining script.
 * Correct: a spoken affirmation and no pearl. Miss or don't-know: the
 * authored lean-in zoom again (fit, then the same pan), then the reveal.
 * The fit reset is the same camera the player already uses at the start of
 * a guide that zooms. No point is copied onto the correction.
 */
export function branchAfterCheckIn(
  guide: TeachingGuide,
  result: CheckInResult,
  copy: CheckInCopy,
  decisionIndex: number | null = decisionBeatIndex(guide)
): CheckInBranch {
  if (result === "correct") {
    return {
      preface: [{ t: 0, actions: [], say: copy.affirm }],
      skipActs: ["pearl"],
    };
  }
  const zoom =
    decisionIndex == null ? null : zoomBefore(guide, decisionIndex);
  if (!zoom) {
    return {
      preface: [{ t: 0, actions: [], say: copy.correction }],
      skipActs: [],
    };
  }
  return {
    preface: [
      {
        t: 0,
        act: "lean-in",
        say: copy.correction,
        actions: [
          { type: "zoom", zoom: 1, pan: [0, 0] },
          { type: "zoom", zoom: zoom.zoom, pan: zoom.pan },
        ],
      },
    ],
    skipActs: [],
  };
}

/**
 * Later beats read the stored result for this finding. Null when the
 * student has not answered it yet — the script stays linear.
 */
export function adaptRemainingFromState(
  guide: TeachingGuide,
  state: readonly FindingCheckInState[],
  findingId: string,
  copy: CheckInCopy
): CheckInBranch | null {
  const row = [...state].reverse().find((item) => item.findingId === findingId);
  if (!row) return null;
  return branchAfterCheckIn(guide, row.result, copy);
}
