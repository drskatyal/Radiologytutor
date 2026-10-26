// Exam / viva click-to-locate.
//
// Teach marks a finding revealed as soon as the guide starts, and it keeps
// speaking after the student switches to Exam. Locate must arm from the
// authored marker and from whether this exam has uncovered it — a teach-time
// reveal is not a locate. Misses hint. A hit is scored by the session.
//
// The tour line stays in the transcript unless Exam entry replaces it. The
// footer caption floor alone left that line under the examiner panel.

import { clickHitsFinding } from "./clickFinding";
import type { Marker } from "./types";

export type LocateSessionMode = "guided" | "socratic" | "free" | "reporting" | "viva";

export type LocateSessionPhase =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking";

const MISS_HINT = "Not quite — click the lesion, or hold the mic to describe it.";
const MISS_AGAIN_HINT = "Still not it — say you don't know, or try one more click.";

export function isExamMode(mode: string): boolean {
  return mode === "viva" || mode === "socratic";
}

export function findingMarkerAuthored(
  marker: Pick<Marker, "x_pct" | "y_pct"> | null | undefined
): marker is Pick<Marker, "x_pct" | "y_pct"> {
  return !!marker && Number.isFinite(marker.x_pct) && Number.isFinite(marker.y_pct);
}

/** True when Exam should accept a click against this finding's marker. */
export function locateModeArmed(input: {
  examMode: boolean;
  finding: { id: string; marker?: Pick<Marker, "x_pct" | "y_pct"> | null } | null | undefined;
  revealedIds: readonly string[];
  locatedIds: readonly string[];
}): boolean {
  const finding = input.finding;
  if (!input.examMode || !finding) return false;
  if (!findingMarkerAuthored(finding.marker)) return false;
  if (input.revealedIds.includes(finding.id)) return false;
  if (input.locatedIds.includes(finding.id)) return false;
  return true;
}

export type ExamEntry = {
  /** Stop guide playback and any clip still in the speaker. */
  interruptSpeech: true;
  /** Drop an in-flight tutor call so it cannot speak or reveal after the switch. */
  abortTutor: true;
  phase: LocateSessionPhase;
  /** Teach spoilers fall away. A finding the student already located stays open. */
  revealedIds: string[];
  /**
   * The examiner caption and the transcript panel must not keep the tour line.
   * Seat a fresh stem in its place (or leave the transcript empty).
   */
  dropPriorCaption: true;
};

/** Turns the examiner caption and the rail are allowed to show. */
export function examinerVisibleTurns<T>(turns: readonly T[], floor: number): T[] {
  const start = Number.isFinite(floor) ? Math.max(0, Math.floor(floor)) : 0;
  if (start <= 0) return [...turns];
  if (start >= turns.length) return [];
  return turns.slice(start);
}

/** Last assistant line in the visible examiner transcript. Null when the panel should sit ready. */
export function examinerCaptionTurn<T extends { role: string; text: string; error?: boolean }>(
  turns: readonly T[],
  floor: number
): T | null {
  const visible = examinerVisibleTurns(turns, floor);
  for (let i = visible.length - 1; i >= 0; i--) {
    const turn = visible[i];
    if (turn.role === "assistant" && !turn.error && turn.text.trim()) return turn;
  }
  return null;
}

export type SeatedExamTranscript<T> = {
  turns: T[];
  /** Zero: the stored list is already the exam, so the panel and the caption agree. */
  captionFloor: 0;
};

/**
 * Teach → Exam. Prior turns are attending tour copy. They are not kept under
 * the examiner chrome. A non-blank stem becomes the only line; a blank stem
 * leaves the transcript empty so the dock can sit at Ready.
 */
export function seatExamTranscript<T extends { text: string }>(
  _prior: readonly unknown[],
  stem: T | null
): SeatedExamTranscript<T> {
  const text = stem?.text.trim() ?? "";
  if (!stem || !text) return { turns: [], captionFloor: 0 };
  return { turns: [{ ...stem, text }], captionFloor: 0 };
}

/**
 * A guide caption write captures the epoch when it was scheduled. Exam entry
 * bumps that epoch; applying the write afterwards would put the tour line
 * back on the seated stem.
 */
export function commitGuideLine<T extends { id: string; text: string }>(
  turns: readonly T[],
  turnId: string,
  line: string,
  epochAtSchedule: number,
  epochNow: number,
  how: "append" | "replace" = "append"
): T[] {
  if (epochAtSchedule !== epochNow) return [...turns];
  const trimmed = line.trim();
  if (!trimmed) return [...turns];
  let found = false;
  const next = turns.map((turn) => {
    if (turn.id !== turnId) return turn;
    found = true;
    const text = how === "replace" || !turn.text.trim() ? trimmed : `${turn.text} ${trimmed}`;
    return { ...turn, text };
  });
  return found ? next : [...turns];
}

/** Same epoch rule for the turn a guide opens before its first line lands. */
export function appendGuideTurn<T extends { id: string }>(
  turns: readonly T[],
  turn: T,
  epochAtSchedule: number,
  epochNow: number
): T[] {
  if (epochAtSchedule !== epochNow) return [...turns];
  if (turns.some((item) => item.id === turn.id)) return [...turns];
  return [...turns, turn];
}

/**
 * Teach → Exam (or Socratic). Null when the session was already an exam, or
 * the new mode is not one: those switches must not wipe reveals.
 */
export function examEntryTransition(input: {
  fromMode: string;
  toMode: string;
  phase: LocateSessionPhase;
  revealedIds: readonly string[];
  locatedIds: readonly string[];
}): ExamEntry | null {
  if (!isExamMode(input.toMode) || isExamMode(input.fromMode)) return null;
  const phase: LocateSessionPhase =
    input.phase === "speaking" || input.phase === "thinking" || input.phase === "transcribing"
      ? "idle"
      : input.phase;
  return {
    interruptSpeech: true,
    abortTutor: true,
    phase,
    revealedIds: input.revealedIds.filter((id) => input.locatedIds.includes(id)),
    dropPriorCaption: true,
  };
}

export type LocateClick =
  | { type: "ignore" }
  | { type: "hit" }
  | { type: "miss"; misses: number; hint: string };

/** Grade one click. `priorMisses` is the count before this click. */
export function applyLocateClick(input: {
  armed: boolean;
  busy: boolean;
  marker: Marker | null | undefined;
  x: number;
  y: number;
  priorMisses: number;
}): LocateClick {
  if (!input.armed || input.busy) return { type: "ignore" };
  if (clickHitsFinding(input.marker, input.x, input.y)) return { type: "hit" };
  const misses = input.priorMisses + 1;
  return {
    type: "miss",
    misses,
    hint: misses >= 2 ? MISS_AGAIN_HINT : MISS_HINT,
  };
}

/**
 * A reveal scheduled before Exam entry captures the old epoch. Applying it
 * after the switch would put the teach spoiler back and disarm locate.
 */
export function mergeExamReveal(
  revealedIds: readonly string[],
  findingId: string,
  epochAtSchedule: number,
  epochNow: number
): string[] {
  if (epochAtSchedule !== epochNow) return [...revealedIds];
  if (revealedIds.includes(findingId)) return [...revealedIds];
  return [...revealedIds, findingId];
}

/** Progress dots and Previous reveal in Teach. In Exam they only change the slice. */
export function spoilFindingOnNavigate(mode: string): boolean {
  return !isExamMode(mode);
}

/**
 * Header badge, findings rail, and progress dots share this step.
 * Teach and Exam both read it. The viewer tween is not part of the step:
 * selecting finding 2 shows "2 / 3" while the slice is still catching up,
 * and a reveal that started earlier must not put the badge back.
 */
export type FindingStep = {
  activeIndex: number;
  /** Monotonic id of the selection that owns the step. */
  selection: number;
};

export function beginFindingStep(): FindingStep {
  return { activeIndex: -1, selection: 0 };
}

/** Header body, e.g. "2 / 3". Null before a finding is selected. */
export function findingStepLabel(index: number, count: number): string | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  return `${index + 1} / ${count}`;
}

/**
 * The student selected a finding (dot, card, next, or previous).
 * The step chrome takes this index now. Null when `index` is outside the
 * case — the previous step stays on screen.
 */
export function commitSelectedFinding(
  step: FindingStep,
  index: number,
  count: number
): FindingStep | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  return { activeIndex: index, selection: step.selection + 1 };
}

/**
 * A viewer transition finished. Only the selection that still owns the
 * step may publish an index. Finding 1's showState resolving after the
 * student picked finding 2 leaves the badge on finding 2.
 */
export function settleFindingReveal(
  step: FindingStep,
  input: { index: number; count: number; selection: number }
): FindingStep {
  if (input.selection !== step.selection) return step;
  if (!Number.isInteger(input.count) || input.count <= 0) return step;
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= input.count) {
    return step;
  }
  if (step.activeIndex === input.index) return step;
  return { ...step, activeIndex: input.index };
}
