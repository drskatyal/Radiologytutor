import { generate, geminiConfigured, parseJsonLoose, type GenerateOptions } from "../gemini";
import type { ExamClaim } from "./types";

export function answerStructureRequest(text: string): GenerateOptions {
  return {
    systemInstruction: 'Structure the supplied learner text only. Return JSON {"claims":[{"text":"verbatim clause","negated":false}]}. Do not add facts, diagnoses, suggestions or a score.',
    jsonOnly: true,
    contents: [{ role: "user", parts: [{ text }] }],
  };
}
export function literalClaims(text: string): ExamClaim[] {
  return text.split(/[.!?;\n]+/).map(s => s.trim()).filter(Boolean).map(text => ({ text,
    negated: /\b(no|not|without|absent|denies|negative)\b/i.test(text) }));
}
/** Injectable at the model boundary. The model never receives a case or rubric. */
export async function structureAnswer(text: string, model?: (request: GenerateOptions) => Promise<{ text: string }>): Promise<ExamClaim[]> {
  const invoke = model ?? (geminiConfigured() ? generate : undefined);
  if (!invoke) return literalClaims(text);
  const result = await invoke(answerStructureRequest(text));
  const parsed = parseJsonLoose<{ claims?: unknown }>(result.text);
  if (!Array.isArray(parsed?.claims)) return [];
  return parsed.claims.filter((c): c is ExamClaim => !!c && typeof c.text === "string" && typeof c.negated === "boolean" && c.text.length > 0 && text.includes(c.text))
    .map(c => ({ text: c.text, negated: c.negated || literalClaims(c.text).some(part => part.negated) }));
}
