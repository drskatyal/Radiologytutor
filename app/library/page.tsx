import { Suspense } from "react";
import {
  DEFAULT_ORG_ID,
  listCatalogCases,
  getCatalogFacets,
  listAuthors,
  listCourses,
  listPlaylists,
} from "@/lib/cases";
import { Breadcrumbs, PageContainer, Skeleton } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { Catalog } from "@/components/catalog/Catalog";
import type { CatalogResponse } from "@/components/catalog/types";
import CasesPrefetcher from "@/components/CasesPrefetcher";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Library · FlowRad Learn",
};

/** The Learn surface — the full filterable case catalog (moved from `/`). */
export default async function LibraryPage() {
  const [cases, facets, authors, courses, playlists] = await Promise.all([
    listCatalogCases(DEFAULT_ORG_ID, { status: "published" }),
    getCatalogFacets(DEFAULT_ORG_ID),
    listAuthors(DEFAULT_ORG_ID),
    listCourses(DEFAULT_ORG_ID, { status: "published" }),
    listPlaylists(DEFAULT_ORG_ID),
  ]);

  const initial: CatalogResponse = { cases, facets, authors, courses, playlists };

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Library" }]} />}
        title="Library"
        description="Every published teaching case, filterable by system, difficulty and author."
      />
      <PageContainer>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Catalog initial={initial} />
        </Suspense>
      </PageContainer>

      <CasesPrefetcher caseIds={cases.map((c) => c.caseId)} />
    </>
  );
}
