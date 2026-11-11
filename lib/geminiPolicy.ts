/** Shared by the server adapter and browser Live setup; no credentials here. */
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
