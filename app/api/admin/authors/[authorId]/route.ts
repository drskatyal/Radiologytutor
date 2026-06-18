// Admin single-author API (org-scoped).
//
//   GET    /api/admin/authors/[authorId]  -> the author
//   PATCH  /api/admin/authors/[authorId]  -> update name/bio/institution/avatar
//   DELETE /api/admin/authors/[authorId]  -> delete the author

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_ORG_ID,
  getAuthor,
  updateAuthor,
  deleteAuthor,
} from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

export async function GET(
  _req: NextRequest,
  { params }: { params: { authorId: string } }
) {
  const author = await getAuthor(ORG, params.authorId);
  if (!author) return NextResponse.json({ error: "Author not found." }, { status: 404 });
  return NextResponse.json({ author });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { authorId: string } }
) {
  try {
    const body = (await req.json()) as {
      name?: string;
      bio?: string | null;
      institution?: string | null;
      avatarUrl?: string | null;
    };
    const patch: Parameters<typeof updateAuthor>[2] = {};
    if (typeof body.name === "string") {
      if (!body.name.trim()) {
        return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
      }
      patch.name = body.name.trim();
    }
    if (body.bio !== undefined) patch.bio = body.bio?.trim() || undefined;
    if (body.institution !== undefined) patch.institution = body.institution?.trim() || undefined;
    if (body.avatarUrl !== undefined) patch.avatarUrl = body.avatarUrl?.trim() || undefined;

    const updated = await updateAuthor(ORG, params.authorId, patch);
    if (!updated) return NextResponse.json({ error: "Author not found." }, { status: 404 });
    return NextResponse.json({ author: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { authorId: string } }
) {
  const ok = await deleteAuthor(ORG, params.authorId);
  if (!ok) return NextResponse.json({ error: "Author not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
