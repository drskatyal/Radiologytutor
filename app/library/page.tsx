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
import { activeOrgId, demoAuthEnabled, getSession } from "@/lib/auth";
import { Breadcrumbs, Button, PageContainer, Skeleton } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { Catalog } from "@/components/catalog/Catalog";
import { MyLearning } from "@/components/catalog/MyLearning";
import type { CatalogResponse } from "@/components/catalog/types";
import type { MyLearningCourse } from "@/components/catalog/MyLearning";
import CasesPrefetcher from "@/components/CasesPrefetcher";
import { DashboardError } from "@/components/home/DashboardError";
import { isPlaceholderCourse, toLearnerCatalog } from "@/lib/catalogPlaceholders";
import type { AppSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Library · RadLearn",
};

function sessionCanTeach(session: AppSession | null): boolean {
  if (!session) return false;
  if (session.user.platformRole === "super_admin") return true;
  const role = session.user.membershipRole;
  return role === "author" || role === "admin" || role === "owner";
}

/** The Learn catalog. Placeholder seed courses and authors are omitted. */
export default async function LibraryPage() {
  const orgId = await activeOrgId();
  const session = await getSession();
  let initial: CatalogResponse | null = null;
  let loadError: string | null = null;
  let enrolledCourses: MyLearningCourse[] = [];

  try {
    const [cases, facets, authors, courses, playlists] = await Promise.all([
      listCatalogCases(orgId, { status: "published" }),
      getCatalogFacets(orgId),
      listAuthors(orgId),
      listCourses(orgId, { status: "published" }),
      listPlaylists(orgId),
    ]);
    initial = toLearnerCatalog({ cases, facets, authors, courses, playlists });

    if (session) {
      const [enrollments, progressList] = await Promise.all([
        listEnrollmentsForUser(session.user.id),
        listProgressForUser(session.user.id),
      ]);
      const active = enrollments.filter((e) => e.status === "active" && e.orgId === orgId);
      const progressByCourse = new Map(progressList.map((p) => [p.courseId, p]));
      const resolved = await Promise.all(active.map((e) => getCourse(orgId, e.courseId)));
      enrolledCourses = resolved
        .filter((c): c is NonNullable<typeof c> => c != null && !isPlaceholderCourse(c))
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
        description="Published teaches. Nothing appears here until a teacher records it and publishes."
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
          <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
            <Catalog
              initial={initial}
              demoEntry={!session && demoAuthEnabled()}
              teachHref={sessionCanTeach(session) ? "/studio" : "/sign-up"}
              uploadHref={sessionCanTeach(session) ? "/studio/new" : "/sign-up"}
            />
          </Suspense>
        </PageContainer>
      )}

      {initial && <CasesPrefetcher caseIds={initial.cases.map((c) => c.caseId)} />}
    </>
  );
}
