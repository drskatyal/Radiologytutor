// Studio "my author profile" API (org-scoped, single-author seam).
//
//   GET   /api/studio/profile  -> the org's primary author (lazily created)
//   PATCH /api/studio/profile  -> update it
//
// This is the explicit placeholder called out in CLAUDE.md §6: once Clerk +
// a first-class AuthorProfile land, this route resolves the SESSION user's
// own profile instead of "the org's one author" — callers (ProfileEditor)
// don't change.

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ORG_ID, getPrimaryAuthor, updateAuthor } from "@/lib/cases";
import { BODY_SYSTEMS, type BodySystem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

function cleanSubspecialties(v: unknown): BodySystem[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const set = v.filter((s): s is BodySystem => (BODY_SYSTEMS as string[]).includes(s));
  return set;
}

export async function GET() {
  const author = await getPrimaryAuthor(ORG);
  return NextResponse.json({ author });
}

export async function PATCH(req: NextRequest) {
  try {
    const author = await getPrimaryAuthor(ORG);
    const body = (await req.json()) as {
      name?: string;
      bio?: string;
      institution?: string;
      avatarUrl?: string;
      credentials?: string;
      subspecialties?: unknown;
      socials?: { website?: string; twitter?: string; linkedin?: string };
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
    if (body.credentials !== undefined) patch.credentials = body.credentials?.trim() || undefined;
    if (body.subspecialties !== undefined) patch.subspecialties = cleanSubspecialties(body.subspecialties);
    if (body.socials !== undefined) {
      const website = body.socials?.website?.trim();
      const twitter = body.socials?.twitter?.trim();
      const linkedin = body.socials?.linkedin?.trim();
      patch.socials = website || twitter || linkedin ? { website, twitter, linkedin } : undefined;
    }

    const updated = await updateAuthor(ORG, author.id, patch);
    return NextResponse.json({ author: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
