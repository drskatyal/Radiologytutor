// IDENTITY SEAM for FlowRad Viewer accounts.
//
// Sign-in is Google Cloud Identity Platform (Firebase Auth): the browser signs
// in with Google or email, gets an ID token, and POSTs it to /api/auth/session.
// This module verifies that token against Google's published keys, then sets
// our own short, HMAC-signed, httpOnly session cookie. No password is stored
// here and no Firebase Admin SDK is needed.
//
// Local development without Identity Platform: VIEWER_DEV_SIGN_IN=1 enables an
// email-only "dev sign-in". It is refused on Cloud Run (K_SERVICE) whatever the
// env says, so it can never ship as a back door.
//
// Nothing outside this file reads or writes the session cookie.

import { createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual, type JsonWebKey } from "node:crypto";

export const SESSION_COOKIE = "fv_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 14;

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface IdentityConfig {
  /** Public web config handed to the browser SDK. */
  apiKey: string;
  authDomain: string;
  projectId: string;
}

export function identityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig | null {
  const apiKey = env.IDENTITY_API_KEY?.trim();
  const projectId = env.IDENTITY_PROJECT_ID?.trim();
  if (!apiKey || !projectId) return null;
  return { apiKey, projectId, authDomain: env.IDENTITY_AUTH_DOMAIN?.trim() || `${projectId}.firebaseapp.com` };
}

export function devSignInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.K_SERVICE) return false;
  return env.VIEWER_DEV_SIGN_IN === "1" || env.NODE_ENV === "development";
}

const DEV_SECRET = "dev-only-flowrad-viewer-session-secret-change-me";

function sessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SESSION_SECRET?.trim();
  if (s) return s;
  if (env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build" && !devSignInEnabled(env)) {
    throw new Error("SESSION_SECRET is not set. Refusing to sign sessions with a public key.");
  }
  return DEV_SECRET;
}

// ---------------------------------------------------------------------------
// Session cookie (HMAC-SHA256 over base64url JSON)
// ---------------------------------------------------------------------------

interface SessionPayload extends SessionUser {
  exp: number;
}

export function signSession(user: SessionUser, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const payload: SessionPayload = { ...user, exp: Math.floor(now / 1000) + SESSION_MAX_AGE_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", sessionSecret(env)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySession(value: string | undefined | null, now = Date.now(), env: NodeJS.ProcessEnv = process.env): SessionUser | null {
  if (!value || value.length > 4096) return null;
  const dot = value.indexOf(".");
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  const mac = Buffer.from(value.slice(dot + 1), "base64url");
  const want = createHmac("sha256", sessionSecret(env)).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof p.id !== "string" || !p.id || typeof p.email !== "string") return null;
    if (typeof p.exp !== "number" || p.exp * 1000 <= now) return null;
    return { id: p.id, email: p.email, name: typeof p.name === "string" ? p.name : undefined };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production" && !devSignInEnabled(env),
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  };
}

/** Dev sign-in user id: stable per email, prefixed so it never collides with a real uid. */
export function devUserId(email: string): string {
  return "dev-" + createHmac("sha256", "flowrad-viewer-dev-user").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
}

export function newUidSalt(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Identity Platform ID token verification (RS256, Google securetoken keys)
// ---------------------------------------------------------------------------

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwksCache: { keys: Record<string, JsonWebKey>; exp: number } | null = null;

async function securetokenKeys(): Promise<Record<string, JsonWebKey>> {
  if (jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
  const res = await fetch(JWKS_URL, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`securetoken keys -> ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys: Record<string, JsonWebKey> = {};
  for (const k of body.keys ?? []) if (k.kid) keys[k.kid] = k;
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  jwksCache = { keys, exp: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  return keys;
}

export interface IdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  auth_time?: number;
}

/** Claim checks, split out so they are unit-tested without network keys. */
export function checkIdTokenClaims(c: Partial<IdTokenClaims>, projectId: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  if (c.aud !== projectId) return "wrong audience";
  if (c.iss !== `https://securetoken.google.com/${projectId}`) return "wrong issuer";
  if (typeof c.sub !== "string" || !c.sub || c.sub.length > 128) return "missing subject";
  if (typeof c.exp !== "number" || c.exp <= nowSec - 30) return "expired";
  if (typeof c.iat !== "number" || c.iat > nowSec + 300) return "issued in the future";
  if (typeof c.auth_time === "number" && c.auth_time > nowSec + 300) return "auth time in the future";
  if (typeof c.email !== "string" || !c.email.includes("@")) return "account has no email";
  return null;
}

export async function verifyIdToken(token: string, cfg: IdentityConfig): Promise<SessionUser> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported ID token header");
  const jwk = (await securetokenKeys())[header.kid];
  if (!jwk) throw new Error("Unknown ID token key");
  const ok = createVerify("RSA-SHA256")
    .update(`${parts[0]}.${parts[1]}`)
    .verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  if (!ok) throw new Error("Bad ID token signature");
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as IdTokenClaims;
  const problem = checkIdTokenClaims(claims, cfg.projectId);
  if (problem) throw new Error(`ID token rejected: ${problem}`);
  return { id: claims.sub, email: claims.email!, name: claims.name };
}
