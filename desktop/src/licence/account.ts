// Account sign-in + plan check for the desktop app (SCAFFOLD for freemium).
//
// Flow (device link; no password ever typed into the app):
//   1. startDeviceLink()  → POST {base}/api/desktop/link        → code + verify URL
//   2. the app opens the verify URL in the user's browser; they sign in to
//      viewer.flowrad.ai and confirm the code
//   3. pollDeviceLink()   → GET  {base}/api/desktop/link/<poll> → device token (once)
//   4. fetchAccountEntitlement(token) → GET {base}/api/desktop/entitlement
//
// Not wired into the UI yet, and it gates NOTHING: the server's entitlement is
// unsigned and advisory, and mergeAccountEntitlement() can only ever turn a
// feature ON or mark the install paid, never switch something off. Real gating
// waits for (a) signed, self-updating builds and (b) a server-signed
// entitlement verified in Rust like the remote config (src-tauri/src/updates.rs).
//
// Transport is injected: the webview's CSP blocks direct fetches to the site,
// so production calls go through a Rust command (the sync seam, src-tauri/src/
// sync.rs). The device token belongs in the OS keychain on the Rust side, never
// in localStorage. These are the remaining wiring steps.

import { normalise, type Entitlement } from "./index";

export interface Http {
  (req: { method: "GET" | "POST"; url: string; json?: unknown; bearer?: string }): Promise<{ status: number; body: unknown }>;
}

export interface DeviceLinkStart {
  pollId: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
  intervalSec: number;
}

export type DeviceLinkPoll =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; deviceToken: string; email: string; entitlement: AccountEntitlement | null };

/** What /api/desktop/entitlement answers (lib/cloud/entitlements.ts). */
export interface AccountEntitlement {
  plan: "free" | "pro" | "super";
  tier: "free" | "paid";
  features: Record<string, boolean>;
  issuedAt: string;
  expiresAt: string;
  signed: boolean;
}

const base = (b: string) => {
  const u = new URL(b);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new Error("The account server must use HTTPS.");
  return u.origin;
};

export async function startDeviceLink(http: Http, server: string, deviceName: string): Promise<DeviceLinkStart> {
  const res = await http({ method: "POST", url: `${base(server)}/api/desktop/link`, json: { deviceName } });
  const b = res.body as Partial<DeviceLinkStart>;
  if (res.status !== 201 || !b.pollId || !b.userCode || !b.verifyUrl) throw new Error("Could not start sign-in. Try again.");
  // Only ever open a verify page on the account server itself.
  if (new URL(b.verifyUrl).origin !== base(server)) throw new Error("Unexpected sign-in address.");
  return { pollId: b.pollId, userCode: b.userCode, verifyUrl: b.verifyUrl, expiresAt: String(b.expiresAt ?? ""), intervalSec: Math.max(2, Number(b.intervalSec) || 5) };
}

export async function pollDeviceLink(http: Http, server: string, pollId: string): Promise<DeviceLinkPoll> {
  const res = await http({ method: "GET", url: `${base(server)}/api/desktop/link/${encodeURIComponent(pollId)}` });
  const b = (res.body ?? {}) as { status?: string; deviceToken?: string; account?: { email?: string }; entitlement?: unknown };
  if (res.status === 404 || b.status === "expired") return { status: "expired" };
  if (b.status === "denied") return { status: "denied" };
  if (b.status === "approved" && typeof b.deviceToken === "string") {
    return { status: "approved", deviceToken: b.deviceToken, email: String(b.account?.email ?? ""), entitlement: parseAccountEntitlement(b.entitlement) };
  }
  return { status: "pending" };
}

export async function fetchAccountEntitlement(http: Http, server: string, deviceToken: string): Promise<AccountEntitlement | null> {
  const res = await http({ method: "GET", url: `${base(server)}/api/desktop/entitlement`, bearer: deviceToken });
  if (res.status === 401) throw new Error("signed-out");
  return res.status === 200 ? parseAccountEntitlement(res.body) : null;
}

export function parseAccountEntitlement(value: unknown): AccountEntitlement | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<AccountEntitlement>;
  const plan = v.plan === "pro" || v.plan === "super" ? v.plan : v.plan === "free" ? "free" : null;
  if (!plan || typeof v.expiresAt !== "string" || Number.isNaN(Date.parse(v.expiresAt))) return null;
  const features: Record<string, boolean> = {};
  for (const [k, on] of Object.entries(v.features ?? {})) if (typeof on === "boolean") features[k] = on;
  return { plan, tier: plan === "free" ? "free" : "paid", features, issuedAt: String(v.issuedAt ?? ""), expiresAt: v.expiresAt, signed: v.signed === true };
}

/**
 * Combine the local entitlement (signed remote config + licence, verified in
 * Rust) with the account's plan. Today, with an UNSIGNED account answer, this
 * can only add: a paid plan marks the install paid and turns features on; it
 * never turns one off. An expired answer is ignored (offline grace is over).
 */
export function mergeAccountEntitlement(local: Entitlement, account: AccountEntitlement | null, now = Date.now()): Entitlement {
  const base = normalise(local);
  if (!account || Date.parse(account.expiresAt) <= now) return base;
  const features = { ...base.features };
  for (const [k, on] of Object.entries(account.features)) {
    if (on) features[k] = true;
    else if (account.signed && features[k] === undefined) features[k] = false;
  }
  return { ...base, tier: base.tier === "paid" || account.tier === "paid" ? "paid" : "free", features };
}

/** The one check feature code should call. Unknown features are allowed (free by default). */
export function featureAllowed(entitlement: Entitlement, feature: string): boolean {
  return entitlement.features[feature] ?? true;
}
