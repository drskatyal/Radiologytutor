// Remote config + licence seam (docs/UPDATES.md). One interface for "is this
// feature on, and is this install paid?", so charging later needs no reinstall.
//
// * Defaults to free with every shipped feature on. Today nothing is paid.
// * Offline-first: the entitlement comes from a signed config cached on disk
//   (verified in Rust on every read, src-tauri/src/updates.rs); the network
//   refresh rides along with the update check and never blocks startup.
// * Nothing about the user, the machine or any study is sent: the refresh is
//   a bare GET to a fixed URL.

import { invoke, isTauri } from "../platform";

export type Tier = "free" | "paid";

export interface Entitlement {
  tier: Tier;
  /** Effective on/off for flags and paid features the remote config names. */
  features: Record<string, boolean>;
  /** Where the config came from: built-in defaults, the disk cache, or just fetched. */
  source: "default" | "cache" | "remote";
  expiresAt?: string | null;
  licensee?: string | null;
  message?: string | null;
}

/**
 * Core viewing that is FREE on every tier, now and later: 3D MPR (multiplanar)
 * and the 3D volume, on Windows and macOS. A remote config or licence can never
 * gate or switch these off. Same list (and names, which are stable API) as
 * FREE_CORE_FEATURES in src-tauri/src/updates.rs and in flowrad-viewer's
 * lib/cloud/entitlements.ts.
 */
export const FREE_CORE_FEATURES = ["mpr", "volume-3d"] as const;
export type FreeCoreFeature = (typeof FREE_CORE_FEATURES)[number];

export function isFreeCore(flag: string): flag is FreeCoreFeature {
  return (FREE_CORE_FEATURES as readonly string[]).includes(flag);
}

export const DEFAULT_ENTITLEMENT: Entitlement = Object.freeze({ tier: "free", features: {}, source: "default" }) as Entitlement;

let current: Entitlement = DEFAULT_ENTITLEMENT;
const listeners = new Set<(e: Entitlement) => void>();

function set(next: Entitlement | null | undefined) {
  current = normalise(next);
  for (const l of listeners) l(current);
}

/** Accept only a well-formed entitlement; anything else is the free default. */
export function normalise(value: unknown): Entitlement {
  if (!value || typeof value !== "object") return DEFAULT_ENTITLEMENT;
  const v = value as Partial<Entitlement>;
  const tier: Tier = v.tier === "paid" ? "paid" : "free";
  const features: Record<string, boolean> = {};
  if (v.features && typeof v.features === "object") {
    for (const [k, on] of Object.entries(v.features)) if (typeof on === "boolean") features[k] = on || isFreeCore(k);
  }
  const source = v.source === "remote" || v.source === "cache" ? v.source : "default";
  return { tier, features, source, expiresAt: v.expiresAt ?? null, licensee: v.licensee ?? null, message: v.message ?? null };
}

/** The current entitlement (synchronous; the free default until loaded). */
export function getEntitlement(): Entitlement {
  return current;
}

/**
 * Is `flag` on? A flag the config doesn't mention keeps `fallback`, which is
 * true for everything that ships today, so an unreachable or empty config
 * never switches a feature off. Free core features (FREE_CORE_FEATURES) are
 * always on.
 */
export function isEnabled(flag: string, fallback = true): boolean {
  if (isFreeCore(flag)) return true;
  return current.features[flag] ?? fallback;
}

export function isPaid(): boolean {
  return current.tier === "paid";
}

export function subscribe(listener: (e: Entitlement) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** From the disk cache only (no network). */
export async function loadEntitlement(): Promise<Entitlement> {
  if (!isTauri) return current;
  try {
    set(await invoke<Entitlement>("entitlement_get"));
  } catch {
    /* keep the default */
  }
  return current;
}

/** Fetch the signed config; offline or unsigned answers keep what we have. */
export async function refreshEntitlement(): Promise<Entitlement> {
  if (!isTauri) return current;
  try {
    set(await invoke<Entitlement>("config_refresh"));
  } catch {
    /* keep the current one */
  }
  return current;
}

/** Store a licence token the user pasted. Throws a readable message if it's not valid. */
export async function setLicence(token: string): Promise<Entitlement> {
  set(await invoke<Entitlement>("licence_set", { token }));
  return current;
}

export async function clearLicence(): Promise<Entitlement> {
  set(await invoke<Entitlement>("licence_clear"));
  return current;
}

/** Tests only. */
export function __setEntitlementForTest(e: unknown) {
  set(e as Entitlement);
}
