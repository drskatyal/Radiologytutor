// Admin playlists API (org-scoped). The client never imports lib/cases (§3).
//
//   GET  /api/admin/playlists  -> this org's playlists
//   POST /api/admin/playlists  -> create a playlist { title, caseIds?, ... }

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import { listPlaylists, createPlaylist } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const orgId = await requireAdminOrg();
    const playlists = await listPlaylists(orgId);
    return NextResponse.json({ playlists });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try {
    const orgId = await requireAdminOrg();
    const body = (await req.json()) as {
      title?: string;
      description?: string;
      caseIds?: string[];
    };
    const title = (body.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ error: "Playlist title is required." }, { status: 400 });
    }
    const playlist = await createPlaylist(orgId, {
      title,
      description: body.description?.trim() || undefined,
      caseIds: Array.isArray(body.caseIds) ? body.caseIds : [],
    });
    return NextResponse.json({ playlist });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
