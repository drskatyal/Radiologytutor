/** Server/Edge only. Never serialize the proxy header or environment secret. */
export const PROXY_SECRET_HEADER = "x-flowrad-proxy-secret";
export type RequestHeaders = Pick<Headers, "get">;

/** Single DNS hostname, without scheme, port, path, list, whitespace or escapes. */
export function validForwardedHostname(value: string): boolean {
  if (!(value.length > 0 && value.length <= 253 && value.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) return false;
  // Also reject URL parser aliases such as non-canonical numeric IPv4 forms.
  try { return new URL(`https://${value}`).hostname === value.toLowerCase(); }
  catch { return false; }
}

/** Fixed local default preserves development/build boot without trusting a request. */
export function configuredPublicOrigin(authUrl = process.env.BETTER_AUTH_URL): string {
  try {
    const url = new URL(authUrl?.trim() || "http://localhost:3000");
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch {
    // Never echo a configuration value: it could accidentally contain a secret.
    throw new Error("BETTER_AUTH_URL must be an HTTP(S) URL without credentials.");
  }
}

/**
 * Native Web Crypto HMAC verification compares fixed-size MACs in constant time.
 * Hash keys to a fixed length first: raw HMAC keys otherwise equate a short key
 * with that key plus NUL padding. No JS string equality or prefix comparison.
 * Works in Next's Edge runtime.
 */
async function authenticatesWorker(expected: string, supplied: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const [expectedKey, suppliedKey] = await Promise.all([
    crypto.subtle.importKey("raw", expectedDigest, algorithm, false, ["sign"]),
    crypto.subtle.importKey("raw", suppliedDigest, algorithm, false, ["verify"]),
  ]);
  const message = encoder.encode("FlowRad trusted proxy host v1");
  const signature = await crypto.subtle.sign("HMAC", expectedKey, message);
  return crypto.subtle.verify("HMAC", suppliedKey, signature, message);
}

/**
 * Only our authenticated HTTPS Worker may supply the public hostname. Host,
 * Forwarded, x-forwarded-proto and NEXT_PUBLIC_APP_URL are never trust inputs.
 */
export async function trustedPublicOrigin(headers: RequestHeaders): Promise<string> {
  const fallback = configuredPublicOrigin();
  const expected = process.env.TRUSTED_PROXY_SECRET;
  const supplied = headers.get(PROXY_SECRET_HEADER);
  if (!expected || !supplied || supplied.length > 4096) return fallback;
  try {
    if (!await authenticatesWorker(expected, supplied)) return fallback;
  } catch {
    return fallback; // Crypto failure must not grant trust or expose key material.
  }
  const host = headers.get("x-forwarded-host");
  if (!host || !validForwardedHostname(host)) return fallback;
  return `https://${host.toLowerCase()}`;
}
