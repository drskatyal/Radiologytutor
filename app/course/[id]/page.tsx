import Link from "next/link";
import { notFound } from "next/navigation";
import { GraduationCap, Layers, PlayCircle, Star } from "lucide-react";
import {
  getCourse,
  getCasesByIds,
  getAuthor,
  getEnrollmentForUserCourse,
  getProgressForUserCourse,
  isCourseWishlisted,
  listReviewsForCourse,
  getCertificateForUserCourse,
  getPublicAssessmentForCourse,
  getBestAttemptForUserAssessment,
} from "@/lib/cases";
import { activeOrgId, getSession } from "@/lib/auth";
import { Badge, Breadcrumbs, Button, EmptyState, PageContainer, SectionHeading, VerifiedBadge } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { difficultyBadgeVariant, difficultyLabel } from "@/lib/taxonomy";
import { CourseCurriculum } from "@/components/catalog/CourseCurriculum";
import { CourseEnrollButton } from "@/components/catalog/CourseEnrollButton";
import { CourseProgressBar } from "@/components/catalog/CourseProgressBar";
import { WishlistButton } from "@/components/catalog/WishlistButton";
import { CourseReviews } from "@/components/catalog/CourseReviews";
import { CourseCertificateCTA } from "@/components/catalog/CourseCertificateCTA";
import { CourseAssessment } from "@/components/catalog/CourseAssessment";
import { RelatedCourses } from "@/components/catalog/RelatedCourses";

export const dynamic = "force-dynamic";

export default async function CoursePage({ params }: { params: { id: string } }) {
  const orgId = await activeOrgId();
  const course = await getCourse(orgId, params.id);
  if (!course) notFound();

  const session = await getSession();
  const assessment = await getPublicAssessmentForCourse(orgId, course.id);
  const [cases, author, enrollment, progress, reviews, wishlisted, certificate, bestAttempt] =
    await Promise.all([
      getCasesByIds(orgId, course.caseIds),
      course.authorId ? getAuthor(orgId, course.authorId) : Promise.resolve(null),
      session
        ? getEnrollmentForUserCourse(session.user.id, course.id)
        : Promise.resolve(null),
      session
        ? getProgressForUserCourse(session.user.id, course.id)
        : Promise.resolve(null),
      listReviewsForCourse(orgId, course.id),
      session ? isCourseWishlisted(session.user.id, course.id) : Promise.resolve(false),
      session
        ? getCertificateForUserCourse(session.user.id, course.id)
        : Promise.resolve(null),
      session && assessment
        ? getBestAttemptForUserAssessment(session.user.id, assessment.id)
        : Promise.resolve(null),
    ]);

  const firstCaseId = cases[0]?.caseId;
  const isEnrolled = enrollment?.status === "active";
  const completedCaseIds = progress?.completedCaseIds ?? [];
  const percentComplete = progress?.percentComplete ?? 0;
  const assessmentPassed = Boolean(bestAttempt?.passed);
  const canClaimCertificate =
    isEnrolled && percentComplete >= 100 && (!assessment || assessmentPassed);

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Library", href: "/library" }, { label: "Course" }]} />}
        title={
          <span className="inline-flex items-center gap-2.5">
            <GraduationCap className="h-5 w-5 text-accent" aria-hidden="true" />
            {course.title}
          </span>
        }
        description={course.description}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <WishlistButton courseId={course.id} initiallyWishlisted={wishlisted} />
            <CourseEnrollButton
              courseId={course.id}
              initiallyEnrolled={isEnrolled}
              firstCaseId={firstCaseId}
            />
            {firstCaseId && (
              <Link href={`/case/${firstCaseId}`}>
                <Button leadingIcon={<PlayCircle className="h-4 w-4" aria-hidden="true" />}>
                  Start course
                </Button>
              </Link>
            )}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {course.difficulty && (
            <Badge variant={difficultyBadgeVariant(course.difficulty)}>
              {difficultyLabel(course.difficulty)}
            </Badge>
          )}
          {course.system && <Badge variant="info">{course.system}</Badge>}
          <Badge variant="neutral" className="gap-1.5 tabular-nums">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {cases.length} case{cases.length === 1 ? "" : "s"}
          </Badge>
          {reviews.count > 0 && (
            <Badge variant="neutral" className="gap-1 tabular-nums">
              <Star className="h-3 w-3 text-warning" fill="currentColor" aria-hidden="true" />
              {reviews.average.toFixed(1)} ({reviews.count})
            </Badge>
          )}
          {author && (
            <span className="inline-flex items-center gap-1.5">
              <Link
                href={`/authors/${author.id}`}
                className="text-xs font-medium text-secondary transition-colors hover:text-accent"
              >
                by {author.name}
              </Link>
              {author.verification === "verified" && (
                <VerifiedBadge status="verified" className="shrink-0" />
              )}
            </span>
          )}
        </div>
        {isEnrolled && (
          <div className="mt-4 max-w-md">
            <CourseProgressBar percent={percentComplete} />
          </div>
        )}
      </PageHeader>

      <PageContainer className="flex flex-col gap-10">
        {canClaimCertificate && (
          <CourseCertificateCTA
            courseId={course.id}
            percentComplete={percentComplete}
            existingCertificate={certificate}
            assessmentPassed={assessmentPassed}
            hasAssessment={Boolean(assessment)}
          />
        )}

        {isEnrolled && percentComplete >= 100 && assessment && !assessmentPassed && !certificate && (
          <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 text-sm text-secondary">
            Finish the post-test below (pass ≥ {assessment.passingScore}%) to unlock your
            Certificate of Completion.
          </div>
        )}

        <section aria-labelledby="curriculum-heading">
          <SectionHeading
            id="curriculum-heading"
            title="Curriculum"
            description="Work through each interactive case in order."
          />
          {cases.length === 0 ? (
            <EmptyState
              className="mt-4"
              icon={<GraduationCap aria-hidden="true" />}
              title="No cases in this course yet"
              description="An admin can add and order cases for this course from the Admin console."
              action={
                <Link href="/library">
                  <Button variant="secondary">Back to library</Button>
                </Link>
              }
            />
          ) : (
            <div className="mt-4">
              <CourseCurriculum
                courseId={course.id}
                cases={cases}
                completedCaseIds={completedCaseIds}
                isEnrolled={isEnrolled}
                author={author ?? undefined}
              />
            </div>
          )}
        </section>

        {assessment && (
          <section aria-labelledby="assessment-heading">
            <SectionHeading
              id="assessment-heading"
              title="Post-test"
              description="MCQ plus click-the-finding — required before your certificate when enrolled."
            />
            <div className="mt-4">
              <CourseAssessment
                courseId={course.id}
                assessment={assessment}
                initialBestAttempt={bestAttempt}
                isEnrolled={isEnrolled}
              />
            </div>
          </section>
        )}

        <section aria-labelledby="reviews-heading">
          <SectionHeading
            id="reviews-heading"
            title="Reviews"
            description="What other learners thought of this course."
            icon={<Star />}
          />
          <div className="mt-4">
            <CourseReviews
              courseId={course.id}
              initial={reviews}
              isSignedIn={Boolean(session)}
            />
          </div>
        </section>

        <RelatedCourses orgId={orgId} course={course} />
      </PageContainer>
    </>
  );
}
