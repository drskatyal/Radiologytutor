// Public catalog API — the filterable case library (CLAUDE.md §2).
//
//   GET /api/catalog?system=&difficulty=&modality=&specialty=&author=&q=&sort=
//     -> published cases matching the filters, the facet values for the filter
//        UI, the org's authors (for attribution), and the course/playlist rails.
//
// The client never imports lib/cases directly (§3) — it talks to this route.
// orgId is a seam (DEFAULT_ORG_ID) until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_ORG_ID,
  listCatalogCases,
  getCatalogFacets,
  listAuthors,
  listCourses,
  listPlaylists,
  type CatalogFilter,
} from "@/lib/cases";
import { BODY_SYSTEMS, DIFFICULTIES, type BodySystem, type Difficulty } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

function asSystem(v: string | null): BodySystem | undefined {
  return v && (BODY_SYSTEMS as string[]).includes(v) ? (v as BodySystem) : undefined;
}

function asDifficulty(v: string | null): Difficulty | undefined {
  return v && (DIFFICULTIES as string[]).includes(v) ? (v as Difficulty) : undefined;
}

function asSort(v: string | null): CatalogFilter["sort"] {
  return v === "title" || v === "difficulty" || v === "recent" ? v : undefined;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const filter: CatalogFilter = {
    status: "published",
    system: asSystem(sp.get("system")),
    difficulty: asDifficulty(sp.get("difficulty")),
    modality: sp.get("modality") || undefined,
    specialty: sp.get("specialty") || undefined,
    authorId: sp.get("author") || undefined,
    q: sp.get("q") || undefined,
    sort: asSort(sp.get("sort")),
  };

  const [cases, facets, authors, courses, playlists] = await Promise.all([
    listCatalogCases(ORG, filter),
    getCatalogFacets(ORG),
    listAuthors(ORG),
    listCourses(ORG, { status: "published" }),
    listPlaylists(ORG),
  ]);

  return NextResponse.json({ cases, facets, authors, courses, playlists });
}
