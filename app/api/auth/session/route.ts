// Sign in (exchange an Identity Platform ID token for our session cookie) and
// sign out. See lib/cloud/session.ts.

import { NextResponse, type NextRequest } from "next/server";
import { ensureAccount, jsonError } from "@/lib/cloud/auth";
import { SESSION_COOKIE, identityConfig, sessionCookieOptions, signSession, verifyIdToken } from "@/lib/cloud/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cfg = identityConfig();
  if (!cfg) return NextResponse.json({ error: "Sign-in is not configured on this server." }, { status: 503 });
  let idToken: unknown;
  try {
    idToken = ((await req.json()) as { idToken?: unknown }).idToken;
  } catch {
    return NextResponse.json({ error: "Send { idToken }." }, { status: 400 });
  }
  if (typeof idToken !== "string" || idToken.length > 8192) {
    return NextResponse.json({ error: "Send { idToken }." }, { status: 400 });
  }
  try {
    const user = await verifyIdToken(idToken, cfg).catch(() => null);
    if (!user) return NextResponse.json({ error: "That sign-in could not be verified. Try again." }, { status: 401 });
    await ensureAccount(user);
    const res = NextResponse.json({ user: { id: user.id, email: user.email, name: user.name ?? null } });
    res.cookies.set(SESSION_COOKIE, signSession(user), sessionCookieOptions());
    return res;
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
