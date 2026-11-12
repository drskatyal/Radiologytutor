/** Shared by the server adapter and browser Live setup; no credentials here. */
export type GeminiCapability = "text" | "tts" | "live";

export class GeminiCapabilityError extends Error {
  readonly code = "GEMINI_UNSUPPORTED_CAPABILITY";
  constructor(public readonly model: string, public readonly capability: GeminiCapability) {
    super(`Gemini model ${model} is not supported for ${capability}; configure the explicit model for that role.`);
    this.name = "GeminiCapabilityError";
  }
}

/** Explicit supported roles. Never replace a configured model with another ID. */
export function assertGeminiCapability(model: string, capability: GeminiCapability): void {
  const id = model.replace(/^models\//, "");
  const supported = capability === "tts"
    ? /^gemini-3\.8-flash(?:-lite)?-tts$/.test(id)
    : capability === "live"
      ? id === "gemini-3.8-live"
      : /^gemini-\d+(?:\.\d+)?-(?:flash|pro)(?:-[a-z0-9]+)*$/.test(id) && !/(?:tts|live|audio)/.test(id);
  if (!supported) throw new GeminiCapabilityError(model, capability);
}

export function deprecatedGeminiSampling(model: string): boolean {
  const match = /^(?:models\/)?gemini-(\d+)(?:\.(\d+))?-/.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 3 || (major === 3 && (minor >= 6 || (minor === 5 && model.includes("flash-lite"))));
}

/** Remove both SDK/proto and REST spellings, without changing other config. */
export function stripDeprecatedSampling(model: string, config: Record<string, unknown>): void {
  if (!deprecatedGeminiSampling(model)) return;
  for (const key of ["temperature", "top_p", "top_k", "topP", "topK"]) delete config[key];
}
