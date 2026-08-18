import { Suspense } from "react";
import {
  DEFAULT_ORG_ID,
  listCatalogCases,
  getCatalogFacets,
  listAuthors,
  listCourses,
  listPlaylists,
} from "@/lib/cases";
import { Breadcrumbs, Button, PageContainer, Skeleton } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { Catalog } from "@/components/catalog/Catalog";
import type { CatalogResponse } from "@/components/catalog/types";
import CasesPrefetcher from "@/components/CasesPrefetcher";
import { DashboardError } from "@/components/home/DashboardError";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Library · FlowRad Learn",
};

/** The Learn catalog — courses, teachers, and cases, one click apart. */
export default async function LibraryPage() {
  let initial: CatalogResponse | null = null;
  let loadError: string | null = null;

  try {
    const [cases, facets, authors, courses, playlists] = await Promise.all([
      listCatalogCases(DEFAULT_ORG_ID, { status: "published" }),
      getCatalogFacets(DEFAULT_ORG_ID),
      listAuthors(DEFAULT_ORG_ID),
      listCourses(DEFAULT_ORG_ID, { status: "published" }),
      listPlaylists(DEFAULT_ORG_ID),
    ]);
    initial = { cases, facets, authors, courses, playlists };
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Something went wrong.";
  }

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Library" }]} />}
        title="Library"
        description="Courses, teachers, and narrated DICOM cases — pick a rail or filter the full catalog."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/library#courses">
              <Button size="sm" variant="secondary">
                Courses
              </Button>
            </Link>
            <Link href="/library#teachers">
              <Button size="sm" variant="secondary">
                Teachers
              </Button>
            </Link>
            <Link href="/library#cases">
              <Button size="sm" variant="secondary">
                Cases
              </Button>
            </Link>
          </div>
        }
      />
      {loadError || !initial ? (
        <DashboardError title="Couldn't load the library" message={loadError ?? "Something went wrong."} />
      ) : (
        <PageContainer>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <Catalog initial={initial} />
          </Suspense>
        </PageContainer>
      )}

      {initial && <CasesPrefetcher caseIds={initial.cases.map((c) => c.caseId)} />}
    </>
  );
}
