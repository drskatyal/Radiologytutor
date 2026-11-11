/** Server-observed request provenance, never model-authored clinical content. */
export interface GeminiRequestMetadata {
  requestedModel: string;
  /** Null means the provider did not report a resolved model version. */
  responseModelVersion: string | null;
  apiSurface: "generateContent" | "interactions";
  /** SHA-256 of the canonical { model, apiSurface, body }; excludes credentials. */
  configHash: string;
}
