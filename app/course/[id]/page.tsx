import Link from "next/link";
import { notFound } from "next/navigation";
import { GraduationCap, Layers, PlayCircle } from "lucide-react";
import { getCourse, getCasesByIds, getAuthor, getEnrollmentForUserCourse } from "@/lib/cases";
import { activeOrgId, getSession } from "@/lib/auth";
import { Badge, Breadcrumbs, Button, EmptyState, PageContainer } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { difficultyBadgeVariant, difficultyLabel } from "@/lib/taxonomy";
import { CourseCases } from "@/components/catalog/CourseCases";
import { CourseEnrollButton } from "@/components/catalog/CourseEnrollButton";

export const dynamic = "force-dynamic";

export default async function CoursePage({ params }: { params: { id: string } }) {
  const orgId = await activeOrgId();
  const course = await getCourse(orgId, params.id);
  if (!course) notFound();

  const session = await getSession();
  const [cases, author, enrollment] = await Promise.all([
    getCasesByIds(orgId, course.caseIds),
    course.authorId ? getAuthor(orgId, course.authorId) : Promise.resolve(null),
    session
      ? getEnrollmentForUserCourse(session.user.id, course.id)
      : Promise.resolve(null),
  ]);

  const firstCaseId = cases[0]?.caseId;
  const isEnrolled = enrollment?.status === "active";

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
          {author && (
            <Link
              href={`/authors/${author.id}`}
              className="text-xs font-medium text-secondary transition-colors hover:text-accent"
            >
              by {author.name}
            </Link>
          )}
        </div>
      </PageHeader>

      <PageContainer>
        {cases.length === 0 ? (
          <EmptyState
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
          <CourseCases cases={cases} author={author ?? undefined} />
        )}
      </PageContainer>
    </>
  );
}
