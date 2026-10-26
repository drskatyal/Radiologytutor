// Cloud Run metadata-server access tokens for the Healthcare API.
// The browser never sees these. Local Orthanc does not call this module.
//
// Optional GOOGLE_ACCESS_TOKEN lets an operator smoke-test a DICOM store
// from a laptop. Production leaves it unset and uses the runtime service
// account (roles/healthcare.dicomEditor on the store only).

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

let cached: { token: string; exp: number } | null = null;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

export async function gcpAccessToken(): Promise<string> {
  const injected = process.env.GOOGLE_ACCESS_TOKEN?.trim();
  if (injected) return injected;

  const now = Date.now();
  if (cached && cached.exp > now + 60_000) return cached.token;

  const res = await fetch(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    cache: "no-store",
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) {
    throw new Error(`GCP metadata token -> ${res.status}`);
  }
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) throw new Error("GCP metadata token -> empty");
  const ttlSec = body.expires_in && body.expires_in > 0 ? body.expires_in : 300;
  cached = { token: body.access_token, exp: now + ttlSec * 1000 };
  return body.access_token;
}

/** Test hook — metadata cache must not leak across cases. */
export function resetGcpAccessTokenCache(): void {
  cached = null;
}
