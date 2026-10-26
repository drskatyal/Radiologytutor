// Exam locate — click-the-finding on a finding the student has not been shown.
// Teach mode reveals markers as it talks. That spoil must not survive the
// switch into Exam/Viva, and a leftover Speaking/thinking lock must not
// swallow the click. Distance stays in lib/clickFinding.ts.

import { clickHitsFinding } from "./clickFinding";
import type { Marker } from "./types";

export type LocatePhase =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking";

/**
 * Teach-tour spoils are not exam reveals. A finding the student already
 * located, or asked to be shown, stays revealed.
 */
export function revealedIdsOnExamEntry(
  locatedIds: readonly string[],
  helpedIds: readonly string[]
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [...locatedIds, ...helpedIds]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** What Exam/Viva entry does to a session that was just in Teach. */
export function examEntryPlan(input: {
  locatedIds: readonly string[];
  helpedIds: readonly string[];
  activeFindingId?: string | null;
}): {
  phase: "idle";
  revealedIds: string[];
  /** True only when this finding was located or helped, so the marker may stay. */
  spoilActive: boolean;
} {
  const revealedIds = revealedIdsOnExamEntry(input.locatedIds, input.helpedIds);
  const spoilActive = Boolean(
    input.activeFindingId && revealedIds.includes(input.activeFindingId)
  );
  return { phase: "idle", revealedIds, spoilActive };
}

/**
 * Selecting a finding outside an exam shows the authored marker.
 * In an exam the marker stays hidden until the student locates it or asks.
 */
export function examSpoilOnSeat(examMode: boolean, alreadyRevealed: boolean): boolean {
  if (!examMode) return true;
  return alreadyRevealed;
}

export function locateModeArmed(input: {
  examMode: boolean;
  findingId?: string | null;
  revealedIds: readonly string[];
  marker?: { x_pct: number; y_pct: number } | null;
}): boolean {
  if (!input.examMode || !input.findingId) return false;
  if (input.revealedIds.includes(input.findingId)) return false;
  const marker = input.marker;
  if (!marker || !Number.isFinite(marker.x_pct) || !Number.isFinite(marker.y_pct)) {
    return false;
  }
  return true;
}

/**
 * Cancel teach speech before the examiner seats the finding.
 * Recording stays recording — the student is still holding the mic.
 * Speaking, thinking, and transcribing return to idle so they cannot
 * latch and block locate.
 */
export function phaseAfterInterrupt(phase: LocatePhase): LocatePhase {
  if (phase === "recording") return "recording";
  return "idle";
}

/**
 * Finding-rail clicks. Exam stays navigable while the examiner is thinking
 * or a teach clip is still marked Speaking. Voice capture still wins.
 */
export function findingNavigationLocked(input: {
  examMode: boolean;
  phase: LocatePhase;
  ready: boolean;
}): boolean {
  if (!input.ready) return true;
  if (input.phase === "recording" || input.phase === "transcribing") return true;
  if (input.examMode) return false;
  return input.phase === "thinking";
}

const SPOIL_ACTION = new Set([
  "show_finding",
  "play_guide",
  "point_to",
  "next_in_tour",
  "prev_in_tour",
  "draw_annotation",
]);

/**
 * Below the reveal rung, drop viewer actions that would draw the answer.
 * Scroll and window stay — those are how a candidate searches.
 * Level 3 may show the finding. An already revealed finding may be pointed at.
 */
export function withholdUnrevealedExamActions<
  T extends { type: string; findingId?: string },
>(
  actions: readonly T[],
  input: {
    examMode: boolean;
    hintLevel: number;
    revealedIds: readonly string[];
    currentFindingId?: string;
  }
): T[] {
  if (!input.examMode || input.hintLevel >= 3) return [...actions];
  const revealed = new Set(input.revealedIds);
  return actions.filter((action) => {
    if (!SPOIL_ACTION.has(action.type)) return true;
    const id = action.findingId ?? input.currentFindingId;
    return Boolean(id && revealed.has(id));
  });
}

export type LocateDecision =
  | { type: "ignore" }
  | { type: "hit" }
  | { type: "miss"; misses: number; hint: string };

const MISS_HINT = "Not quite — click the lesion, or hold the mic to describe it.";
const MISS_HINT_AGAIN =
  "Still not it — say you don't know, or try one more click.";

/**
 * Score one click. `phase` is required so a Speaking or thinking lock is
 * visible at the call site — it must not turn a hit into an ignore. Interrupt
 * maps those phases to idle; a click that arrives before that clear still counts.
 */
export function decideLocateClick(input: {
  examMode: boolean;
  revealed: boolean;
  marker: Marker | null | undefined;
  x: number;
  y: number;
  misses: number;
  phase: LocatePhase;
}): LocateDecision {
  if (!input.examMode || input.revealed || !input.marker) return { type: "ignore" };
  // `phase` is part of the contract so a Speaking or thinking lock cannot
  // grow a gate here. Interrupt clears those phases; a click during them
  // still counts. (A phase gate used to drop the click via `busy`.)
  void input.phase;
  if (clickHitsFinding(input.marker, input.x, input.y)) return { type: "hit" };
  const misses = input.misses + 1;
  return {
    type: "miss",
    misses,
    hint: misses >= 2 ? MISS_HINT_AGAIN : MISS_HINT,
  };
}
