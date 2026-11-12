/**
 * Teacher-studio capture rules that the UI and the compile call both share.
 * Finish holds the take. Process is a separate step. Long viewport video
 * uses Gemini's agentic media path; short takes stay on stills.
 */

import { AGENTIC_VIDEO_MIN_MS } from "./compileMedia";
import type { RecordedTrack } from "./types";

export { AGENTIC_VIDEO_MIN_MS };

/** Visible status while Flash compiles and the pack is written. */
export const TEACHER_PROCESSING_LABEL = "Processing…";

/** Student case opened from Test as student. Live reads the stored pack. */
export function studentCaseHref(caseId: string, mode: "teach" | "exam" = "teach"): string {
  return `/case/${encodeURIComponent(caseId)}?mode=${mode}`;
}

export function studentIntentFromQuery(mode: string | undefined | null): "teach" | "exam" | undefined {
  const value = mode?.trim().toLowerCase();
  if (value === "exam" || value === "examiner" || value === "viva") return "exam";
  if (value === "teach" || value === "guided") return "teach";
  return undefined;
}

export function useAgenticViewportVideo(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= AGENTIC_VIDEO_MIN_MS;
}

export type FinishOutcome = "empty" | "notes" | "review";

/**
 * Finish never compiles. A voiced take waits for Process. A silent take
 * stays on the notes draft.
 */
export function phaseAfterFinish(input: { hasTrack: boolean; hasAudio: boolean }): FinishOutcome {
  if (!input.hasTrack) return "empty";
  if (!input.hasAudio) return "notes";
  return "review";
}

export function compileProgressPlan(agenticVideo: boolean): string[] {
  return [
    "Saving the recording",
    agenticVideo ? "Uploading the viewport recording" : "Sending the viewer log",
    "Compiling with Gemini",
    "Writing the teaching pack",
  ];
}

export interface ReviewMark {
  t: number;
  label: string;
}

/** Log marks for the review timeline. Pointer coordinates are not labels. */
export function reviewTimeline(track: RecordedTrack, limit = 24): ReviewMark[] {
  const marks: ReviewMark[] = [
    { t: 0, label: `Slice ${displaySlice(track.start.sliceIndex)}` },
  ];
  for (const event of track.events) {
    if (event.type === "slice") marks.push({ t: event.t, label: `Slice ${displaySlice(event.index)}` });
    else if (event.type === "voi") marks.push({ t: event.t, label: "Window" });
    else if (event.type === "series") marks.push({ t: event.t, label: "Series" });
    else if (event.type === "camera") marks.push({ t: event.t, label: "Zoom" });
    else if (event.type === "annotation") marks.push({ t: event.t, label: event.label?.trim() || "Annotation" });
    else if (event.type === "compare") marks.push({ t: event.t, label: event.open ? "Compare" : "Close compare" });
  }
  if (marks.length <= limit) return marks;
  const last = marks.length - 1;
  const picked = new Set<number>([0, last]);
  const denom = Math.max(1, limit - 1);
  for (let i = 0; i < limit; i++) picked.add(Math.round((i * last) / denom));
  return [...picked]
    .sort((a, b) => a - b)
    .map((index) => marks[index])
    .filter((mark): mark is ReviewMark => Boolean(mark));
}

function displaySlice(index: number): number {
  return Number.isFinite(index) ? index + 1 : 1;
}
