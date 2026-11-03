// GET /api/me/prefs  -> the signed-in user's viewer preferences (mouse & keyboard bindings)
// PUT /api/me/prefs  -> save { bindings } (the shared bindings file; newest copy wins)
//
// Org-scoped through the session (never a client-supplied orgId). Signed out:
// GET answers { signedIn: false } (no error noise on public viewer pages) and
// the viewer keeps its localStorage copy; PUT is 401.

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, getSession, jsonAuthError, requireSession } from "@/lib/auth";
import { getUserPrefs, saveUserBindings } from "@/lib/cases";
import { BINDINGS_FORMAT, BINDINGS_VERSION } from "@flowrad/viewer-core/bindings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BYTES = 32 * 1024;

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ signedIn: false, bindings: null }, { headers: NO_STORE });
    const orgId = await activeOrgId();
    const prefs = await getUserPrefs(orgId, session.user.id);
    return NextResponse.json({ signedIn: true, bindings: prefs?.bindings ?? null }, { headers: NO_STORE });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    return NextResponse.json({ error: "Could not load your preferences." }, { status: 500, headers: NO_STORE });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireSession();
    const orgId = await activeOrgId();
    const text = await req.text();
    if (text.length > MAX_BYTES) return NextResponse.json({ error: "Preferences are too large." }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
    }
    const b = (body as { bindings?: unknown })?.bindings as Record<string, unknown> | undefined;
    if (!b || b.format !== BINDINGS_FORMAT || typeof b.version !== "number" || b.version > BINDINGS_VERSION || typeof b.overrides !== "object" || !b.overrides) {
      return NextResponse.json({ error: "Not a bindings file." }, { status: 400 });
    }
    // Shape only: ids and specs are strings; the viewer validates against its command table on load.
    const overrides: Record<string, string[]> = {};
    for (const [id, specs] of Object.entries(b.overrides as Record<string, unknown>)) {
      if (typeof id !== "string" || id.length > 64 || !Array.isArray(specs)) continue;
      overrides[id] = specs.filter((s): s is string => typeof s === "string" && s.length <= 40).slice(0, 8);
    }
    const saved = await saveUserBindings(orgId, user.id, {
      format: BINDINGS_FORMAT,
      version: BINDINGS_VERSION,
      surface: b.surface === "desktop" ? "desktop" : "web",
      updatedAt: typeof b.updatedAt === "string" ? b.updatedAt : undefined,
      overrides,
    });
    return NextResponse.json({ bindings: saved.bindings ?? null }, { headers: NO_STORE });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    return NextResponse.json({ error: "Could not save your preferences." }, { status: 500, headers: NO_STORE });
  }
}
