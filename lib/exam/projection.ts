import type { CaseData } from "../types";

declare const learnerSafe: unique symbol;
export type LearnerSafeCase = {
  readonly [learnerSafe]: true;
  caseId: string;
  title: string;
  modality: string;
  stem: string;
  studyRefs: Array<{ studyInstanceUID: string; seriesInstanceUIDs: string[] }>;
  findingCount: number;
  findingOrder: number[];
};
export const isExamMode = (mode?: string | null) => ["exam", "examiner", "viva", "socratic"].includes(mode?.toLowerCase() ?? "");

/** Explicit allowlist: no title/diagnosis, answer-bearing IDs, anchor hints or teaching pack. */
export function learnerCaseProjection(data: CaseData, _mode: "exam" | "examiner" = "exam"): LearnerSafeCase {
  return {
    caseId: data.caseId, title: "Imaging examination", modality: data.modality,
    stem: "Review the images and describe your observations.",
    studyRefs: (data.studyRefs ?? []).map(ref => ({ studyInstanceUID: ref.studyInstanceUID,
      seriesInstanceUIDs: [...(ref.seriesInstanceUIDs ?? [])] })),
    findingCount: data.findings.length,
    findingOrder: data.findings.map((_, index) => index + 1),
  } as LearnerSafeCase;
}
/** Neutral middle-of-stack selection belongs to the viewer, never to a finding. */
export const examInitialView = { openSlice: () => null };
