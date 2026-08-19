// Admin authors API (org-scoped). The client never imports lib/cases (§3).
//
//   GET  /api/admin/authors  -> this org's authors (for pickers + management)
//   POST /api/admin/authors  -> create an author { name, bio?, institution?, avatarUrl? }
//
// orgId comes from the session (activeOrgId) — never from the client.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { listAuthors, createAuthor } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const orgId = await requireAuthorOrg();
    const authors = await listAuthors(orgId);
    return NextResponse.json({ authors });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try {
    const orgId = await requireAuthorOrg();
    const body = (await req.json()) as {
      name?: string;
      bio?: string;
      institution?: string;
      avatarUrl?: string;
    };
    const name = (body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ error: "Author name is required." }, { status: 400 });
    }
    const author = await createAuthor(orgId, {
      name,
      bio: body.bio?.trim() || undefined,
      institution: body.institution?.trim() || undefined,
      avatarUrl: body.avatarUrl?.trim() || undefined,
    });
    return NextResponse.json({ author });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
