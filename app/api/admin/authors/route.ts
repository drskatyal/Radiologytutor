// Admin authors API (org-scoped). The client never imports lib/cases (§3).
//
//   GET  /api/admin/authors  -> this org's authors (for pickers + management)
//   POST /api/admin/authors  -> create an author { name, bio?, institution?, avatarUrl? }
//
// orgId is a seam (DEFAULT_ORG_ID) until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ORG_ID, listAuthors, createAuthor } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

export async function GET() {
  const authors = await listAuthors(ORG);
  return NextResponse.json({ authors });
}

export async function POST(req: NextRequest) {
  try {
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
    const author = await createAuthor(ORG, {
      name,
      bio: body.bio?.trim() || undefined,
      institution: body.institution?.trim() || undefined,
      avatarUrl: body.avatarUrl?.trim() || undefined,
    });
    return NextResponse.json({ author });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
