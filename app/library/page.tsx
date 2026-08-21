import { Suspense } from "react";
import Link from "next/link";
import {
  getCourse,
  listAuthors,
  listCatalogCases,
  getCatalogFacets,
  listCourses,
  listPlaylists,
  listEnrollmentsForUser,
  listProgressForUser,
} from "@/lib/cases";
import { activeOrgId, getSession } from "@/lib/auth";
import { Breadcrumbs, Button, PageContainer, Skeleton } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { Catalog } from "@/components/catalog/Catalog";
import { MyLearning } from "@/components/catalog/MyLearning";
import type { CatalogResponse } from "@/components/catalog/types";
import type { MyLearningCourse } from "@/components/catalog/MyLearning";
import CasesPrefetcher from "@/components/CasesPrefetcher";
import { DashboardError } from "@/components/home/DashboardError";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Library · FlowRad Learn",
};

/** The Learn catalog — courses, teachers, and cases, one click apart. */
export default async function LibraryPage() {
  const orgId = await activeOrgId();
  let initial: CatalogResponse | null = null;
  let loadError: string | null = null;
  let enrolledCourses: MyLearningCourse[] = [];

  try {
    const session = await getSession();
    const [cases, facets, authors, courses, playlists] = await Promise.all([
      listCatalogCases(orgId, { status: "published" }),
      getCatalogFacets(orgId),
      listAuthors(orgId),
      listCourses(orgId, { status: "published" }),
      listPlaylists(orgId),
    ]);
    initial = { cases, facets, authors, courses, playlists };

    if (session) {
      const [enrollments, progressList] = await Promise.all([
        listEnrollmentsForUser(session.user.id),
        listProgressForUser(session.user.id),
      ]);
      const active = enrollments.filter((e) => e.status === "active" && e.orgId === orgId);
      const progressByCourse = new Map(progressList.map((p) => [p.courseId, p]));
      const resolved = await Promise.all(active.map((e) => getCourse(orgId, e.courseId)));
      enrolledCourses = resolved
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((course) => ({
          ...course,
          percentComplete: progressByCourse.get(course.id)?.percentComplete,
        }));
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Something went wrong.";
  }

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Library" }]} />}
        title="Library"
        description="Courses, teachers, and narrated DICOM cases."
        actions={
          <Link href="/learning">
            <Button size="sm" variant="secondary">
              My learning
            </Button>
          </Link>
        }
      />
      {loadError || !initial ? (
        <DashboardError title="Couldn't load the library" message={loadError ?? "Something went wrong."} />
      ) : (
        <PageContainer>
          <MyLearning courses={enrolledCourses} />
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <Catalog initial={initial} />
          </Suspense>
        </PageContainer>
      )}

      {initial && <CasesPrefetcher caseIds={initial.cases.map((c) => c.caseId)} />}
    </>
  );
}
