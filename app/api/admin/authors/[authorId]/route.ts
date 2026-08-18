// Admin single-author API (org-scoped).
//
//   GET    /api/admin/authors/[authorId]  -> the author
//   PATCH  /api/admin/authors/[authorId]  -> update name/bio/institution/avatar
//   DELETE /api/admin/authors/[authorId]  -> delete the author

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import { getAuthor, updateAuthor, deleteAuthor } from "@/lib/cases";
import type { AuthorProfile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { authorId: string } }
) {
  try {
    const orgId = await requireAdminOrg();
    const author = await getAuthor(orgId, params.authorId);
    if (!author) return NextResponse.json({ error: "Author not found." }, { status: 404 });
    return NextResponse.json({ author });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { authorId: string } }
) {
  try {
    const orgId = await requireAdminOrg();
    const body = (await req.json()) as {
      name?: string;
      bio?: string | null;
      institution?: string | null;
      avatarUrl?: string | null;
      verification?: AuthorProfile["verification"];
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
    if (body.verification !== undefined) {
      const allowed: AuthorProfile["verification"][] = [
        "unverified",
        "pending",
        "verified",
        "rejected",
      ];
      if (!allowed.includes(body.verification)) {
        return NextResponse.json({ error: "Invalid verification status." }, { status: 400 });
      }
      patch.verification = body.verification;
    }

    const updated = await updateAuthor(orgId, params.authorId, patch);
    if (!updated) return NextResponse.json({ error: "Author not found." }, { status: 404 });
    return NextResponse.json({ author: updated });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { authorId: string } }
) {
  try {
    const orgId = await requireAdminOrg();
    const ok = await deleteAuthor(orgId, params.authorId);
    if (!ok) return NextResponse.json({ error: "Author not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}
