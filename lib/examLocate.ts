// Exam / viva click-to-locate.
//
// Teach marks a finding revealed as soon as the guide starts, and it keeps
// speaking after the student switches to Exam. Locate must arm from the
// authored marker and from whether this exam has uncovered it — a teach-time
// reveal is not a locate. Misses hint. A hit is scored by the session.

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
  /** Footer caption must not keep reading the tour line. */
  dropPriorCaption: true;
};

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
