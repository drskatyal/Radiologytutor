// Local-development sign-in: email only, no password. Off unless
// VIEWER_DEV_SIGN_IN=1 (or `next dev`), and always off on Cloud Run.

import { NextResponse, type NextRequest } from "next/server";
import { ensureAccount, jsonError } from "@/lib/cloud/auth";
import { SESSION_COOKIE, devSignInEnabled, devUserId, sessionCookieOptions, signSession } from "@/lib/cloud/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!devSignInEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; name?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  try {
    const user = { id: devUserId(email), email, name: typeof body.name === "string" ? body.name.slice(0, 80) : undefined };
    await ensureAccount(user);
    const res = NextResponse.json({ user });
    res.cookies.set(SESSION_COOKIE, signSession(user), sessionCookieOptions());
    return res;
  } catch (err) {
    return jsonError(err);
  }
}
