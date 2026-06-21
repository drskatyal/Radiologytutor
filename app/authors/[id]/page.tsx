import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building2, GraduationCap, LayoutGrid } from "lucide-react";
import {
  DEFAULT_ORG_ID,
  getAuthor,
  listCatalogCases,
  listCourses,
} from "@/lib/cases";
import { Badge, EmptyState, PageContainer, SectionHeading } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { CaseCardGrid } from "@/components/catalog/CaseCard";
import { CoursesRail } from "@/components/catalog/Rails";

export const dynamic = "force-dynamic";

export default async function AuthorPage({ params }: { params: { id: string } }) {
  const author = await getAuthor(DEFAULT_ORG_ID, params.id);
  if (!author) notFound();

  const [cases, allCourses] = await Promise.all([
    listCatalogCases(DEFAULT_ORG_ID, { authorId: author.id, status: "published" }),
    listCourses(DEFAULT_ORG_ID, { status: "published" }),
  ]);
  const courses = allCourses.filter((c) => c.authorId === author.id);

  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <>
      <PageHeader
        breadcrumbs={
          <>
            <Link
              href="/"
              className="inline-flex items-center gap-1 font-medium transition-colors hover:text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Library
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-secondary">Author</span>
          </>
        }
        title={
          <span className="inline-flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-elevated text-sm font-semibold text-secondary ring-1 ring-inset ring-subtle">
              {initials}
            </span>
            {author.name}
          </span>
        }
        description={author.bio}
      >
        <div className="flex flex-wrap items-center gap-2">
          {author.institution && (
            <Badge variant="neutral" className="gap-1.5">
              <Building2 className="h-3 w-3" aria-hidden="true" />
              {author.institution}
            </Badge>
          )}
          <Badge variant="neutral" className="gap-1.5 tabular-nums">
            <LayoutGrid className="h-3 w-3" aria-hidden="true" />
            {cases.length} case{cases.length === 1 ? "" : "s"}
          </Badge>
          {courses.length > 0 && (
            <Badge variant="neutral" className="gap-1.5 tabular-nums">
              <GraduationCap className="h-3 w-3" aria-hidden="true" />
              {courses.length} course{courses.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      </PageHeader>

      <PageContainer className="flex flex-col gap-10">
        {courses.length > 0 && (
          <section className="flex flex-col gap-4">
            <SectionHeading
              icon={<GraduationCap aria-hidden="true" />}
              title="Courses"
              description={`Multi-case teaching sequences from ${author.name}.`}
            />
            <CoursesRail
              courses={courses}
              authorById={{ [author.id]: author }}
              showHeading={false}
            />
          </section>
        )}

        <section className="flex flex-col gap-4">
          <SectionHeading
            icon={<LayoutGrid aria-hidden="true" />}
            title="Cases"
            description={`Published teaching cases from ${author.name}.`}
            aside={
              cases.length > 0 ? (
                <Badge variant="neutral" className="tabular-nums">
                  {cases.length}
                </Badge>
              ) : undefined
            }
          />
          {cases.length === 0 ? (
            <EmptyState
              icon={<GraduationCap aria-hidden="true" />}
              title="No published cases yet"
              description="This author hasn't published any teaching cases."
            />
          ) : (
            <CaseCardGrid cases={cases} authorById={{ [author.id]: author }} />
          )}
        </section>
      </PageContainer>
    </>
  );
}
