// Web viewer preferences synced to the account (today: mouse/keyboard
// bindings; components/viewer/useViewerBindings.ts). Signed out is not an
// error: the viewer keeps its local copy.

import { NextResponse, type NextRequest } from "next/server";
import { HttpError, currentUser, ensureAccount, jsonError } from "@/lib/cloud/auth";
import { readJson } from "@/lib/cloud/api";
import { viewerStore } from "@/lib/cloud/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = currentUser();
    if (!user) return NextResponse.json({ signedIn: false });
    const account = await ensureAccount(user);
    return NextResponse.json({ signedIn: true, bindings: account.bindings ?? null });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = currentUser();
    if (!user) throw new HttpError(401, "Sign in to sync preferences.");
    await ensureAccount(user);
    const body = (await readJson(req, 32 * 1024)) as { bindings?: unknown };
    if (!body.bindings || typeof body.bindings !== "object") throw new HttpError(400, "Send { bindings }.");
    await viewerStore().patchAccount(user.id, { bindings: body.bindings });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
