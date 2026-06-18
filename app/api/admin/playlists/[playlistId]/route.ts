// Admin single-playlist API (org-scoped).
//
//   GET    /api/admin/playlists/[playlistId]  -> the playlist
//   PATCH  /api/admin/playlists/[playlistId]  -> update title/description/caseIds
//   DELETE /api/admin/playlists/[playlistId]  -> delete the playlist

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_ORG_ID,
  getPlaylist,
  updatePlaylist,
  deletePlaylist,
} from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

export async function GET(
  _req: NextRequest,
  { params }: { params: { playlistId: string } }
) {
  const playlist = await getPlaylist(ORG, params.playlistId);
  if (!playlist) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
  return NextResponse.json({ playlist });
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

    const updated = await updatePlaylist(ORG, params.playlistId, patch);
    if (!updated) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    return NextResponse.json({ playlist: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { playlistId: string } }
) {
  const ok = await deletePlaylist(ORG, params.playlistId);
  if (!ok) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
