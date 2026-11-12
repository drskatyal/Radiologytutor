import { NextResponse } from "next/server";
import { getSession, toClientUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who is signed in. Signed out is a normal answer, not an error: 200 with
 * `{ user: null }`. (A 401 here logged a red console error on every page a
 * visitor opened before signing in.) Routes that REQUIRE a session still 401.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ user: null }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ user: toClientUser(session.user) });
}
