/** Server configuration contract. Names/requirements only; never serialize secrets. */
export const PROVISIONAL_GCS_BUCKET_ENV = "GCS_OBJECT_BUCKET" as const;

export const ENV_SCHEMA = {
  NODE_ENV: { kind: "plain", requiredInProduction: true },
  DICOMWEB_BACKEND: { kind: "plain", requiredInProduction: true },
  HEALTHCARE_PROJECT: { kind: "plain", requiredInProduction: true },
  HEALTHCARE_LOCATION: { kind: "plain", requiredInProduction: true },
  HEALTHCARE_DATASET: { kind: "plain", requiredInProduction: true },
  HEALTHCARE_DICOM_STORE: { kind: "plain", requiredInProduction: true },
  MONGODB_DB: { kind: "plain", requiredInProduction: true },
  GEMINI_MODEL: { kind: "plain", requiredInProduction: false },
  GEMINI_TTS_MODEL: { kind: "plain", requiredInProduction: false },
  GEMINI_TTS_VOICE: { kind: "plain", requiredInProduction: false },
  GEMINI_LIVE_MODEL: { kind: "plain", requiredInProduction: false },
  GEMINI_TIMEOUT_MS: { kind: "plain", requiredInProduction: false },
  VOICE_LATENCY_BUDGET_MS: { kind: "plain", requiredInProduction: false },
  ELEVENLABS_TTS_MODEL: { kind: "plain", requiredInProduction: false },
  FRAME_CACHE_WAIT_MS: { kind: "plain", requiredInProduction: false },
  DEMO_AUTH_ENABLED: { kind: "plain", requiredInProduction: false },
  DEMO_AUTH_MAX_ROLE: { kind: "plain", requiredInProduction: false },
  BETTER_AUTH_URL: { kind: "plain", requiredInProduction: true },
  GEMINI_API_KEY: { kind: "secret", requiredInProduction: false },
  BETTER_AUTH_SECRET: { kind: "secret", requiredInProduction: true },
  MONGODB_URI: { kind: "secret", requiredInProduction: true },
  GOOGLE_CLIENT_ID: { kind: "secret", requiredInProduction: false },
  GOOGLE_CLIENT_SECRET: { kind: "secret", requiredInProduction: false },
  ELEVENLABS_API_KEY: { kind: "secret", requiredInProduction: false },
  TRUSTED_PROXY_SECRET: { kind: "secret", requiredInProduction: true },
  [PROVISIONAL_GCS_BUCKET_ENV]: { kind: "plain", requiredInProduction: true, provisional: true },
} as const;

export type RuntimeEnvName = keyof typeof ENV_SCHEMA;
export type RuntimeEnvironment = Partial<Record<RuntimeEnvName, string>>;

/** Never includes values in diagnostics, including for malformed configuration. */
export function missingProductionEnv(env: RuntimeEnvironment): RuntimeEnvName[] {
  return (Object.keys(ENV_SCHEMA) as RuntimeEnvName[]).filter(name => ENV_SCHEMA[name].requiredInProduction && !env[name]?.trim());
}

export function readGcsBucket(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const bucket = env[PROVISIONAL_GCS_BUCKET_ENV]?.trim();
  if (!bucket) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error(`${PROVISIONAL_GCS_BUCKET_ENV} must be a bare bucket name.`);
  return bucket;
}

export function requiresCloudStorage(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.K_SERVICE) || env.DICOMWEB_BACKEND?.trim().toLowerCase() === "healthcare";
}

/** Required before a durable write, never silently use ephemeral Cloud Run disk. */
export function assertDurableStorageConfigured(env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (requiresCloudStorage(env) && !readGcsBucket(env)) throw new Error(`${PROVISIONAL_GCS_BUCKET_ENV} is required for durable Healthcare imports and media (provisional name; confirm with GCP Admin).`);
}
