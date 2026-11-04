// Desktop plan / entitlement seam (scaffold for freemium).
//
// Today NOTHING is gated: every desktop feature is on for every plan. The
// point is the wiring: a signed-in desktop app learns its account's plan, so a
// later release can gate a feature by moving it into PAID_FEATURES — a server
// change, delivered with no reinstall, because builds self-update first.
//
// The answer is ADVISORY until it is signed. Unsigned, the desktop never turns
// a feature off because of it (desktop/src/licence/account.ts). Signing it
// needs an entitlement key held server-side (Secret Manager), separate from
// the updater key; see docs/DESKTOP_RELEASE_READINESS.md.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { planById, type PlanId } from "./plans";

/** Desktop features a plan could gate. Names are stable API: never rename. */
export const DESKTOP_FEATURES = ["pacs", "export-video", "export-dicom", "mpr", "volume-3d", "fusion", "multi-monitor", "voice"] as const;
export type DesktopFeature = (typeof DESKTOP_FEATURES)[number];

/** Which plans unlock each paid feature. EMPTY TODAY: everything is free. */
export const PAID_FEATURES: Partial<Record<DesktopFeature, readonly PlanId[]>> = {};

/** How long a desktop may keep using a fetched entitlement offline. */
export const OFFLINE_GRACE_MS = 7 * 86_400_000;

export interface AccountEntitlement {
  plan: PlanId;
  tier: "free" | "paid";
  features: Record<DesktopFeature, boolean>;
  issuedAt: string;
  /** After this the desktop falls back to its local (free) entitlement. */
  expiresAt: string;
  /** False until entitlement signing ships: the desktop treats it as advisory. */
  signed: false;
}

export function entitlementForPlan(planId: string | null | undefined, now = Date.now()): AccountEntitlement {
  const plan = planById(planId).id;
  const features = {} as Record<DesktopFeature, boolean>;
  for (const f of DESKTOP_FEATURES) {
    const plans = PAID_FEATURES[f];
    features[f] = !plans || plans.includes(plan);
  }
  return {
    plan,
    tier: plan === "free" ? "free" : "paid",
    features,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OFFLINE_GRACE_MS).toISOString(),
    signed: false,
  };
}

// ---------------------------------------------------------------------------
// Device link: sign a desktop app in through the browser (no password in the
// app). The app asks for a code, the user approves it on viewer.flowrad.ai
// while signed in, and the app collects a device token by polling.
// ---------------------------------------------------------------------------

export const DEVICE_LINK_TTL_MS = 10 * 60_000;
export const DEVICE_TOKEN_TTL_SEC = 90 * 86_400;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export interface DeviceLink {
  pollId: string;
  userCode: string;
  deviceName: string;
  status: "pending" | "approved" | "denied" | "collected";
  userId?: string;
  createdAt: string;
  expiresAt: string;
}

export function newUserCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normaliseUserCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 8 || [...c].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export function newDeviceLink(deviceName: unknown, now = Date.now()): DeviceLink {
  const name = typeof deviceName === "string" && deviceName.trim() ? deviceName.trim().slice(0, 60) : "FlowRad Viewer";
  return {
    pollId: randomBytes(24).toString("base64url"),
    userCode: newUserCode(),
    deviceName: name,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DEVICE_LINK_TTL_MS).toISOString(),
  };
}

export function deviceLinkExpired(link: Pick<DeviceLink, "expiresAt">, now = Date.now()): boolean {
  return Date.parse(link.expiresAt) <= now;
}

// Device tokens: HMAC like the session cookie, but domain-separated so a
// session cookie can never be replayed as a device token or the reverse.

function deviceSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SESSION_SECRET?.trim();
  if (s) return `device-token-v1\u0000${s}`;
  if (env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build" && env.VIEWER_DEV_SIGN_IN !== "1") {
    throw new Error("SESSION_SECRET is not set.");
  }
  return "device-token-v1\u0000dev-only-flowrad-viewer-session-secret-change-me";
}

export function signDeviceToken(userId: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const body = Buffer.from(JSON.stringify({ sub: userId, kind: "device", exp: Math.floor(now / 1000) + DEVICE_TOKEN_TTL_SEC })).toString("base64url");
  return `${body}.${createHmac("sha256", deviceSecret(env)).update(body).digest("base64url")}`;
}

export function verifyDeviceToken(token: string | null | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (!token || token.length > 2048) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", deviceSecret(env)).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { sub?: unknown; kind?: unknown; exp?: unknown };
    if (p.kind !== "device" || typeof p.sub !== "string" || typeof p.exp !== "number" || p.exp * 1000 <= now) return null;
    return p.sub;
  } catch {
    return null;
  }
}

export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m ? m[1]! : null;
}
