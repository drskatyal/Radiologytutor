// Student-adaptive re-seat for the learner clock.
//
// The cleaned script stays linear when the registrar follows it. Orient already
// scrolls to the money slice, so commit and pearl land on that slice and this
// module stays quiet. If the viewport is still far when a naming beat is about
// to play — they wandered, or they resumed off the stack — we scroll them
// there and say a directional line before the pointer or the diagnosis.
//
// Pearl names the finding. This hint must not. Do not run the line through
// tutorSpeech.ensureSpokenAnswer: guided mode appends the finding name.

import type { TeachAct, TeachBeat, TeachingGuide } from "./types";

/** Slices away from the money slice that count as lost. */
export const FAR_SLICE_DISTANCE = 8;

const NAMING_ACTS: ReadonlySet<TeachAct> = new Set(["commit", "pearl"]);

export function isNamingAct(act: TeachAct | undefined): boolean {
  return act != null && NAMING_ACTS.has(act);
}

/**
 * Finding to teach after `index`, or null when this was the last one.
 * A negative index (viewer not seated yet) starts at the first finding.
 */
export function nextGuidedIndex(index: number, count: number): number | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (!Number.isFinite(index) || index < 0) return 0;
  if (index >= count - 1) return null;
  return index + 1;
}

export interface MoneySlice {
  sliceIndex: number;
  seriesInstanceUID?: string;
}

/** Last scroll in the script. In a #21 guide that is the orient landing. */
export function moneySliceFromGuide(guide: TeachingGuide): MoneySlice | null {
  let hit: MoneySlice | null = null;
  for (const beat of guide.beats) {
    for (const action of beat.actions) {
      if (action.type !== "scroll") continue;
      hit = {
        sliceIndex: action.sliceIndex,
        ...(action.seriesInstanceUID
          ? { seriesInstanceUID: action.seriesInstanceUID }
          : {}),
      };
    }
  }
  return hit;
}

export function studentIsFar(
  here: number | null | undefined,
  target: number | null | undefined,
  farSlices: number = FAR_SLICE_DISTANCE
): boolean {
  if (here == null || target == null) return false;
  if (!Number.isFinite(here) || !Number.isFinite(target)) return false;
  return Math.abs(here - target) > farSlices;
}

/**
 * Anatomical place the hint may name, without a leading article.
 * A landmark that contains a withheld term (the finding label) is dropped
 * so the line cannot diagnose early.
 */
export function safePlace(
  landmark: string | undefined,
  withhold: readonly string[] | undefined
): string {
  const place = (landmark ?? "").trim().replace(/^the\s+/i, "");
  if (!place) return "level we're teaching";
  const blocked = (withhold ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 2);
  const lower = place.toLowerCase();
  if (blocked.some((term) => lower.includes(term))) return "level we're teaching";
  return place;
}

/**
 * Axial stacks number the apex as slice 0, so a smaller index is higher
 * in the patient.
 */
export function reseatLine(current: number, target: number, place: string): string {
  const direction = current < target ? "too high" : "too low";
  return `You're still ${direction} — come toward the ${place}.`;
}

export function reseatBeat(input: {
  currentSlice: number;
  targetSlice: number;
  t: number;
  landmark?: string;
  withhold?: readonly string[];
  seriesInstanceUID?: string;
}): TeachBeat {
  const place = safePlace(input.landmark, input.withhold);
  return {
    t: input.t,
    act: "search",
    say: reseatLine(input.currentSlice, input.targetSlice, place),
    actions: [
      {
        type: "scroll",
        sliceIndex: input.targetSlice,
        ...(input.seriesInstanceUID
          ? { seriesInstanceUID: input.seriesInstanceUID }
          : {}),
      },
    ],
  };
}
