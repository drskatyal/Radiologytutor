// Admin single-playlist API (org-scoped).
//
//   GET    /api/admin/playlists/[playlistId]  -> the playlist
//   PATCH  /api/admin/playlists/[playlistId]  -> update title/description/caseIds
//   DELETE /api/admin/playlists/[playlistId]  -> delete the playlist

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { getPlaylist, updatePlaylist, deletePlaylist } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { playlistId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const playlist = await getPlaylist(orgId, params.playlistId);
    if (!playlist) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    return NextResponse.json({ playlist });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

interface PatchBody {
  title?: string;
  description?: string | null;
  caseIds?: string[];
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { playlistId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const body = (await req.json()) as PatchBody;
    const patch: Parameters<typeof updatePlaylist>[2] = {};
    if (typeof body.title === "string") {
      if (!body.title.trim()) {
        return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
      }
      patch.title = body.title.trim();
    }
    if (body.description !== undefined) patch.description = body.description?.trim() || undefined;
    if (Array.isArray(body.caseIds)) patch.caseIds = body.caseIds;

    const updated = await updatePlaylist(orgId, params.playlistId, patch);
    if (!updated) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    return NextResponse.json({ playlist: updated });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { playlistId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const ok = await deletePlaylist(orgId, params.playlistId);
    if (!ok) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}
