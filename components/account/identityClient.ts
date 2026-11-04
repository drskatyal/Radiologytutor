"use client";

// Browser side of the identity seam: Google Cloud Identity Platform through
// the Firebase Auth SDK. Loaded only on the sign-in page (and sign-out), never
// in the viewer bundle. The web config is public by design; the server
// verifies every ID token (lib/cloud/session.ts).

import type { IdentityConfig } from "@/lib/cloud/session";

let ready: Promise<typeof import("firebase/auth") & { auth: import("firebase/auth").Auth }> | null = null;

function load(cfg?: IdentityConfig) {
  if (!ready) {
    if (!cfg) throw new Error("Identity Platform is not loaded");
    ready = (async () => {
      const [{ initializeApp, getApps }, authMod] = await Promise.all([import("firebase/app"), import("firebase/auth")]);
      const app = getApps()[0] ?? initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId });
      return { ...authMod, auth: authMod.getAuth(app) };
    })();
  }
  return ready;
}

async function exchange(idToken: string): Promise<void> {
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Sign-in failed. Try again.");
  }
}

export async function signInWithGoogle(cfg: IdentityConfig): Promise<void> {
  const fb = await load(cfg);
  const result = await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider());
  await exchange(await result.user.getIdToken());
}

const EMAIL_KEY = "fv-signin-email";

/** Send a one-time sign-in link (no password to remember or leak). */
export async function sendEmailLink(cfg: IdentityConfig, email: string, next: string): Promise<void> {
  const fb = await load(cfg);
  const url = new URL("/sign-in", window.location.origin);
  url.searchParams.set("next", next);
  await fb.sendSignInLinkToEmail(fb.auth, email, { url: url.toString(), handleCodeInApp: true });
  try {
    window.localStorage.setItem(EMAIL_KEY, email);
  } catch {
    /* private mode: the user re-enters the email when the link opens */
  }
}

/** Complete an email-link sign-in if this page was opened from one. */
export async function completeEmailLink(cfg: IdentityConfig, askEmail: () => string | null): Promise<boolean> {
  const fb = await load(cfg);
  if (!fb.isSignInWithEmailLink(fb.auth, window.location.href)) return false;
  let email: string | null = null;
  try {
    email = window.localStorage.getItem(EMAIL_KEY);
  } catch {
    email = null;
  }
  email ??= askEmail();
  if (!email) return false;
  const result = await fb.signInWithEmailLink(fb.auth, email, window.location.href);
  try {
    window.localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* ignore */
  }
  await exchange(await result.user.getIdToken());
  return true;
}

export async function signOutIdentity(): Promise<void> {
  if (!ready) return;
  const fb = await ready;
  await fb.signOut(fb.auth);
}
