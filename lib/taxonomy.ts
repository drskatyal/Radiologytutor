// Shared, presentation-level helpers for the library taxonomy (difficulty +
// body system). Pure data/strings — safe to import from both server components
// and client components. The canonical lists live in lib/types.ts.

import type { BodySystem, Difficulty } from "./types";

/** A semantic Badge variant (mirrors components/ui Badge variants). */
export type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/** Sentence-case label for a difficulty tier. */
export function difficultyLabel(d: Difficulty): string {
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/** Badge variant for a difficulty tier (beginner→success, advanced→danger). */
export function difficultyBadgeVariant(d: Difficulty): BadgeVariant {
  switch (d) {
    case "beginner":
      return "success";
    case "intermediate":
      return "warning";
    case "advanced":
      return "danger";
  }
}

/** Short blurb describing a course/case at a given difficulty (for empty hints). */
export const DIFFICULTY_BLURB: Record<Difficulty, string> = {
  beginner: "Approachable cases to build a search pattern.",
  intermediate: "Cases that reward a systematic read.",
  advanced: "Subtle or complex findings for sharpening judgement.",
};

/** All body systems with a short caption, for "browse by system" rails. */
export const SYSTEM_CAPTION: Record<BodySystem, string> = {
  Neuro: "Brain, spine and CNS imaging.",
  MSK: "Bones, joints and soft tissue.",
  Chest: "Lungs, mediastinum and pleura.",
  Cardiac: "Heart and great vessels.",
  Abdominal: "Solid organs and bowel.",
  GU: "Kidneys, bladder and pelvis.",
  "Head & Neck": "Sinuses, orbits and neck.",
  Paediatric: "Imaging in children.",
  Vascular: "Arteries, veins and angiography.",
};
