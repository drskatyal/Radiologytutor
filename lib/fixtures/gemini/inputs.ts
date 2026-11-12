import type { CompileSessionInput } from "../../compileSession";
import type { TeachingPlanInput } from "../../gemini";

/** Synthetic media bytes and prose only; transport is always mocked. */
export const extractionInput: CompileSessionInput = {
  transcript: "Synthetic teaching observation.", durationMs: 300000,
  video: { base64: "AAAA", mimeType: "video/webm" },
};
export const planInput: TeachingPlanInput = {
  question: "Explain the synthetic finding.", history: [], caseTitle: "Synthetic CT",
  modality: "CT", mode: "guided", findingsContext: "Approved synthetic observation.",
};
export const ttsText = "Review the synthetic image.";
