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
  listCasesForOrg,
  listActiveSharesForOrg,
} from "@/lib/cases";
import { activeOrgId, demoAuthEnabled, getSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { Breadcrumbs, Button, PageContainer, SectionHeading, Skeleton } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { Catalog } from "@/components/catalog/Catalog";
import { MyLearning } from "@/components/catalog/MyLearning";
import type { CatalogResponse } from "@/components/catalog/types";
import type { MyLearningCourse } from "@/components/catalog/MyLearning";
import CasesPrefetcher from "@/components/CasesPrefetcher";
import { DashboardError } from "@/components/home/DashboardError";
import { isPlaceholderCourse, toLearnerCatalog } from "@/lib/catalogPlaceholders";
import { caseHasTeachingPack, sharePath, studyUidsForCase } from "@/lib/caseShare";
import { CaseLocker, type LockerCase } from "@/components/library/CaseLocker";
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

/**
 * Case locker. Courses stay on this page for the teach catalog, under the
 * studies you can open and share without starting the tutor.
 */
export default async function LibraryPage() {
  const orgId = await activeOrgId();
  const session = await getSession();
  const canManage = sessionCanTeach(session);

  let rows: LockerCase[] = [];
  let lockerError: string | null = null;
  try {
    const cases = await listCasesForOrg(orgId, canManage ? {} : { status: "published" });
    const shares = canManage ? await listActiveSharesForOrg(orgId) : [];
    const shareByCase = new Map(shares.map((share) => [share.caseId, share]));
    rows = cases.map((item) => {
      const live = shareByCase.get(item.caseId);
      return {
        caseId: item.caseId,
        title: item.title,
        modality: item.modality,
        status: item.status,
        updatedAt: item.updatedAt,
        studyCount: studyUidsForCase(item).length,
        hasPack: caseHasTeachingPack(item),
        sharePath: live ? sharePath(live.id) : null,
      };
    });
  } catch (err) {
    lockerError = err instanceof Error ? err.message : "Something went wrong.";
  }

  let initial: CatalogResponse | null = null;
  let catalogError: string | null = null;
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
      const active = enrollments.filter((entry) => entry.status === "active" && entry.orgId === orgId);
      const progressByCourse = new Map(progressList.map((entry) => [entry.courseId, entry]));
      const resolved = await Promise.all(active.map((entry) => getCourse(orgId, entry.courseId)));
      enrolledCourses = resolved
        .filter((course): course is NonNullable<typeof course> => course != null && !isPlaceholderCourse(course))
        .map((course) => ({
          ...course,
          percentComplete: progressByCourse.get(course.id)?.percentComplete,
        }));
    }
  } catch (err) {
    catalogError = err instanceof Error ? err.message : "Something went wrong.";
  }

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Library" }]} />}
        title="Library"
        description="A case locker. Open a study in the viewer, or copy a link someone can open without an account. Teaching stays a separate step."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManage ? (
              <Link href="/studio/new">
                <Button size="sm">Add a case</Button>
              </Link>
            ) : null}
            <Link href="/learning">
              <Button size="sm" variant="secondary">
                My learning
              </Button>
            </Link>
          </div>
        }
      />

      {lockerError ? (
        <DashboardError title="Couldn't load the library" message={lockerError} />
      ) : (
        <CaseLocker
          cases={rows}
          canManageShare={canManage}
          addCaseHref={canManage ? "/studio/new" : undefined}
        />
      )}

      <PageContainer className="pb-16">
        <section id="courses" className="mt-4 flex flex-col gap-6 border-t border-subtle pt-10">
          <SectionHeading
            title="Courses"
            description="Recorded teaches and curricula."
          />
          {catalogError || !initial ? (
            <DashboardError
              title="Couldn't load courses"
              message={catalogError ?? "Something went wrong."}
            />
          ) : (
            <>
              <MyLearning courses={enrolledCourses} />
              <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
                <Catalog
                  initial={initial}
                  demoEntry={!session && demoAuthEnabled()}
                  teachHref={canManage ? "/studio" : "/sign-up"}
                  uploadHref={canManage ? "/studio/new" : "/sign-up"}
                />
              </Suspense>
            </>
          )}
        </section>
      </PageContainer>

      {rows.length > 0 ? <CasesPrefetcher caseIds={rows.map((item) => item.caseId)} /> : null}
    </>
  );
}
