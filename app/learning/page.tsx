import Link from "next/link";
import {
  Award,
  Bookmark,
  GraduationCap,
  Library,
} from "lucide-react";
import {
  getCourse,
  getCasesByIds,
  listEnrollmentsForUser,
  listProgressForUser,
  listWishlistForUser,
  listCertificatesForUser,
} from "@/lib/cases";
import { activeOrgId, getSession } from "@/lib/auth";
import {
  Badge,
  Breadcrumbs,
  Button,
  EmptyState,
  PageContainer,
  SectionHeading,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { ContinueLearning } from "@/components/learning/ContinueLearning";
import { CourseProgressBar } from "@/components/catalog/CourseProgressBar";
import type { Course, Progress } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "My learning · FlowRad Learn",
};

export default async function LearningPage() {
  const session = await getSession();
  if (!session) {
    return (
      <>
        <PageHeader
          breadcrumbs={
            <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "My learning" }]} />
          }
          title="My learning"
          description="Sign in to track progress, save courses, and earn certificates."
        />
        <PageContainer>
          <EmptyState
            icon={<GraduationCap aria-hidden="true" />}
            title="Sign in to continue"
            description="Your enrolled courses, wishlist, and certificates live here."
            action={
              <Link href="/sign-in?next=/learning">
                <Button>Sign in</Button>
              </Link>
            }
          />
        </PageContainer>
      </>
    );
  }

  const orgId = await activeOrgId();
  const [enrollments, progressList, wishlist, certificates] = await Promise.all([
    listEnrollmentsForUser(session.user.id),
    listProgressForUser(session.user.id),
    listWishlistForUser(session.user.id),
    listCertificatesForUser(session.user.id),
  ]);

  const activeEnrollments = enrollments.filter(
    (e) => e.status === "active" && e.orgId === orgId
  );
  const enrolledCourses = (
    await Promise.all(activeEnrollments.map((e) => getCourse(orgId, e.courseId)))
  ).filter((c): c is Course => Boolean(c));

  const progressByCourse = new Map(progressList.map((p) => [p.courseId, p]));
  const continueItems = enrolledCourses
    .map((course) => {
      const progress = progressByCourse.get(course.id);
      if (!progress || progress.percentComplete >= 100) return null;
      return { course, progress };
    })
    .filter((item): item is { course: Course; progress: Progress } => Boolean(item))
    .sort((a, b) => b.progress.updatedAt.localeCompare(a.progress.updatedAt));

  const wishlistCourses = (
    await Promise.all(wishlist.map((w) => getCourse(orgId, w.courseId)))
  ).filter((c): c is Course => Boolean(c));

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "My learning" }]} />
        }
        title="My learning"
        description="Progress, saved courses, and certificates — all in one place."
        actions={
          <Link href="/library">
            <Button size="sm" variant="secondary" leadingIcon={<Library className="h-4 w-4" aria-hidden="true" />}>
              Browse library
            </Button>
          </Link>
        }
      />

      <PageContainer className="flex flex-col gap-10">
        {continueItems.length > 0 && <ContinueLearning items={continueItems} />}

        <section aria-labelledby="enrolled-heading">
          <SectionHeading
            id="enrolled-heading"
            title="Enrolled courses"
            description="Every course you are actively taking."
            icon={<GraduationCap />}
            aside={
              <Badge variant="neutral" className="tabular-nums">
                {enrolledCourses.length}
              </Badge>
            }
          />
          {enrolledCourses.length === 0 ? (
            <EmptyState
              className="mt-4"
              icon={<GraduationCap aria-hidden="true" />}
              title="No enrollments yet"
              description="Browse the library and enroll in a course to start learning."
              action={
                <Link href="/library#courses">
                  <Button variant="secondary">Browse courses</Button>
                </Link>
              }
            />
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {enrolledCourses.map((course) => {
                const progress = progressByCourse.get(course.id);
                return (
                  <li key={course.id}>
                    <Link
                      href={`/course/${course.id}`}
                      className="flex flex-col gap-3 rounded-xl border border-subtle bg-elevated p-4 transition-colors hover:border-strong"
                    >
                      <span className="font-display text-sm font-semibold text-primary">
                        {course.title}
                      </span>
                      {progress ? (
                        <CourseProgressBar percent={progress.percentComplete} />
                      ) : (
                        <p className="text-xs text-muted">Not started yet</p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="wishlist-heading">
          <SectionHeading
            id="wishlist-heading"
            title="Wishlist"
            description="Courses you saved for later."
            icon={<Bookmark />}
            aside={
              <Badge variant="neutral" className="tabular-nums">
                {wishlistCourses.length}
              </Badge>
            }
          />
          {wishlistCourses.length === 0 ? (
            <EmptyState
              className="mt-4"
              icon={<Bookmark aria-hidden="true" />}
              title="Nothing saved yet"
              description="Tap the bookmark on any course to save it here."
              action={
                <Link href="/library#courses">
                  <Button variant="secondary">Explore courses</Button>
                </Link>
              }
            />
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {wishlistCourses.map((course) => (
                <li key={course.id}>
                  <Link
                    href={`/course/${course.id}`}
                    className="block rounded-xl border border-subtle bg-elevated p-4 transition-colors hover:border-strong"
                  >
                    <span className="font-display text-sm font-semibold text-primary">
                      {course.title}
                    </span>
                    {course.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{course.description}</p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="certificates-heading">
          <SectionHeading
            id="certificates-heading"
            title="Certificates"
            description="Certificates of Completion — not CME credit."
            icon={<Award />}
            aside={
              <Badge variant="neutral" className="tabular-nums">
                {certificates.length}
              </Badge>
            }
          />
          {certificates.length === 0 ? (
            <EmptyState
              className="mt-4"
              icon={<Award aria-hidden="true" />}
              title="No certificates yet"
              description="Complete every case in a course to earn a Certificate of Completion."
            />
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {certificates.map((cert) => (
                <li key={cert.id}>
                  <Link
                    href={`/certificate/${cert.id}`}
                    className="flex flex-col gap-2 rounded-xl border border-subtle bg-elevated p-4 transition-colors hover:border-strong"
                  >
                    <span className="font-display text-sm font-semibold text-primary">
                      {cert.courseTitle}
                    </span>
                    <span className="text-xs text-muted">
                      Issued{" "}
                      {new Date(cert.issuedAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </span>
                    <Badge variant="neutral">Certificate of Completion</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageContainer>
    </>
  );
}
