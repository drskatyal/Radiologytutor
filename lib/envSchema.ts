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

export class ProductionEnvError extends Error {
  constructor(readonly missing: string[], readonly invalid: string[]) {
    super(`Invalid production environment.${missing.length ? ` Missing required variables: ${missing.join(", ")}.` : ""}${invalid.length ? ` Invalid variables: ${invalid.join(", ")}.` : ""} See docs/radlearn/ENV_SCHEMA.md.`);
    this.name = "ProductionEnvError";
  }
}

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

/** Production entry points call this once, before Next starts listening.
 * Pure validation: no filesystem, auth, DNS, database or provider requests.
 * Build/dev/fixture runners do not invoke the production entry point.
 */
export function validateProductionEnv(env: Readonly<Record<string, string | undefined>>): void {
  const missing: string[] = missingProductionEnv(env);
  const invalid = new Set<string>();
  const present = (name: string) => Boolean(env[name]?.trim());
  if (present("NODE_ENV") && env.NODE_ENV !== "production") invalid.add("NODE_ENV");
  if (present("DICOMWEB_BACKEND") && env.DICOMWEB_BACKEND !== "healthcare") invalid.add("DICOMWEB_BACKEND");
  for (const name of ["HEALTHCARE_PROJECT", "HEALTHCARE_LOCATION", "HEALTHCARE_DATASET", "HEALTHCARE_DICOM_STORE"]) {
    if (present(name) && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(env[name]!)) invalid.add(name);
  }
  if (present("MONGODB_DB") && /[\s/\\.\"$*<>:|?\x00]/.test(env.MONGODB_DB!)) invalid.add("MONGODB_DB");
  if (present("MONGODB_URI") && !/^mongodb(?:\+srv)?:\/\/\S+$/.test(env.MONGODB_URI!)) invalid.add("MONGODB_URI");
  if (present("BETTER_AUTH_URL")) {
    try {
      const url = new URL(env.BETTER_AUTH_URL!);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (!(url.protocol === "https:" || (local && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) invalid.add("BETTER_AUTH_URL");
    } catch { invalid.add("BETTER_AUTH_URL"); }
  }
  try { readGcsBucket(env); } catch { invalid.add(PROVISIONAL_GCS_BUCKET_ENV); }
  for (const name of ["GEMINI_TIMEOUT_MS", "VOICE_LATENCY_BUDGET_MS", "FRAME_CACHE_WAIT_MS", "PORT"]) {
    if (!present(name)) continue;
    const value = env[name]!;
    const minimum = name === "FRAME_CACHE_WAIT_MS" ? 0 : 1;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || (name === "PORT" && Number(value) > 65535)) invalid.add(name);
  }
  if (present("DEMO_AUTH_ENABLED") && !["0", "1"].includes(env.DEMO_AUTH_ENABLED!)) invalid.add("DEMO_AUTH_ENABLED");
  if (present("DEMO_AUTH_MAX_ROLE") && !["student", "author"].includes(env.DEMO_AUTH_MAX_ROLE!)) invalid.add("DEMO_AUTH_MAX_ROLE");
  if (present("GOOGLE_CLIENT_ID") !== present("GOOGLE_CLIENT_SECRET")) missing.push(present("GOOGLE_CLIENT_ID") ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID");
  if (missing.length || invalid.size) throw new ProductionEnvError(missing, [...invalid]);
}
