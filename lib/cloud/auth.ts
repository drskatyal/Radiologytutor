// Next.js glue for the identity seam: read the session in server components
// and route handlers, and provision the Account row on first sign-in.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, newUidSalt, verifySession, type SessionUser } from "./session";
import { viewerStore } from "./store";
import type { Account } from "./types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function currentUser(): SessionUser | null {
  return verifySession(cookies().get(SESSION_COOKIE)?.value);
}

export function requireUser(): SessionUser {
  const user = currentUser();
  if (!user) throw new HttpError(401, "Sign in to continue.");
  return user;
}

/** The signed-in user's Account, created (free plan, fresh salt) on first use. */
export async function ensureAccount(user: SessionUser): Promise<Account> {
  const store = viewerStore();
  const existing = await store.getAccount(user.id);
  if (existing) return existing;
  const account: Account = {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: "free",
    uidSalt: newUidSalt(),
    createdAt: new Date().toISOString(),
  };
  await store.putAccount(account);
  return account;
}

/** Uniform JSON error for route handlers; never leaks internals. */
export function jsonError(err: unknown): NextResponse {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error("viewer api error", err instanceof Error ? err.message : "unknown");
  return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
}
