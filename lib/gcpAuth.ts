// Server-only ADC for the attached Cloud Run service account. No key files,
// well-known credential-file discovery, injected access tokens or browser keys.
import { Compute, GoogleAuth } from "google-auth-library";

let auth: GoogleAuth<Compute> | undefined;

export function createRuntimeGoogleAuth(): GoogleAuth<Compute> {
  const scopes = ["https://www.googleapis.com/auth/cloud-platform"];
  // Supplying the runtime ADC client prevents GoogleAuth's file-discovery path.
  return new GoogleAuth({ authClient: new Compute({ scopes }), scopes });
}

export async function gcpAccessToken(): Promise<string> {
  try {
    auth ??= createRuntimeGoogleAuth();
    const token = await auth.getAccessToken();
    if (!token) throw new Error();
    return token;
  } catch {
    // Provider exceptions may contain request headers. Never echo or log them.
    throw new Error("GCP runtime ADC authentication failed.");
  }
}

/** Tests only. Token expiry/refresh is managed by google-auth-library. */
export function resetGcpAccessTokenCache(): void { auth = undefined; }
