import {
  DEFAULT_ORG_ID,
  listAuthors,
  listCatalogCases,
  listCourses,
} from "@/lib/cases";
import { getSession } from "@/lib/auth";
import CasesPrefetcher from "@/components/CasesPrefetcher";
import { MarketplaceHero } from "@/components/home/MarketplaceHero";
import { FeaturedMarketplace } from "@/components/home/FeaturedMarketplace";
import { DashboardError } from "@/components/home/DashboardError";
import type { Author, Case, Course } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "FlowRad Learn",
  description: "The marketplace where radiologists teach radiology — narrated DICOM cases with an AI tutor.",
};

function countsByAuthor(items: { authorId?: string }[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const item of items) {
    if (!item.authorId) continue;
    map[item.authorId] = (map[item.authorId] ?? 0) + 1;
  }
  return map;
}

/**
 * Marketplace home — brand-led hero, then featured courses, teachers, and cases.
 * The full filterable catalog lives at /library.
 */
export default async function HomePage() {
  let cases: Case[] = [];
  let courses: Course[] = [];
  let authors: Author[] = [];
  let loadError: string | null = null;

  const session = await getSession();

  try {
    [cases, courses, authors] = await Promise.all([
      listCatalogCases(DEFAULT_ORG_ID, { status: "published" }),
      listCourses(DEFAULT_ORG_ID, { status: "published" }),
      listAuthors(DEFAULT_ORG_ID),
    ]);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Something went wrong.";
  }

  const authorById = Object.fromEntries(authors.map((a) => [a.id, a]));

  return (
    <>
      <MarketplaceHero signedIn={Boolean(session)} />

      {loadError ? (
        <DashboardError title="Couldn't load the marketplace" message={loadError} />
      ) : (
        <FeaturedMarketplace
          courses={courses}
          authors={authors}
          cases={cases}
          authorById={authorById}
          caseCountByAuthor={countsByAuthor(cases)}
          courseCountByAuthor={countsByAuthor(courses)}
        />
      )}

      {!loadError && <CasesPrefetcher caseIds={cases.slice(0, 6).map((c) => c.caseId)} />}
    </>
  );
}
