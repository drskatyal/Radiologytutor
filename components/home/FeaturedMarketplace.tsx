import Link from "next/link";
import { ArrowRight, GraduationCap, LayoutGrid, Users } from "lucide-react";
import { Button, EmptyState, PageContainer, SectionHeading } from "@/components/ui";
import { CaseCardGrid } from "@/components/catalog/CaseCard";
import { CoursesRail, TeachersRail } from "@/components/catalog/Rails";
import type { Author, Case, Course } from "@/lib/types";

const FEATURED = 6;

function BrowseAll({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-sm font-medium text-secondary transition-colors hover:text-accent"
    >
      {label}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

/** Below-fold marketplace rails — courses, teachers, cases. Nothing else. */
export function FeaturedMarketplace({
  courses,
  authors,
  cases,
  authorById,
  caseCountByAuthor,
  courseCountByAuthor,
}: {
  courses: Course[];
  authors: Author[];
  cases: Case[];
  authorById: Record<string, Author>;
  caseCountByAuthor: Record<string, number>;
  courseCountByAuthor: Record<string, number>;
}) {
  const featuredCourses = courses.slice(0, FEATURED);
  const featuredAuthors = authors.slice(0, FEATURED);
  const featuredCases = cases.slice(0, FEATURED);

  return (
    <PageContainer className="flex flex-col gap-14 py-12">
      <section className="flex flex-col gap-4">
        {featuredCourses.length === 0 ? (
          <>
            <SectionHeading
              icon={<GraduationCap aria-hidden="true" />}
              title="Featured courses"
              description="Multi-case sequences from the library."
            />
            <EmptyState
              icon={<GraduationCap aria-hidden="true" />}
              title="No courses yet"
              description="Published teaching sequences will appear here."
              action={
                <Link href="/library#courses">
                  <Button variant="secondary">Open the library</Button>
                </Link>
              }
            />
          </>
        ) : (
          <CoursesRail
            courses={featuredCourses}
            authorById={authorById}
            title="Featured courses"
            description="Multi-case sequences, taught end to end."
            aside={<BrowseAll href="/library#courses" label="All courses" />}
          />
        )}
      </section>

      <section className="flex flex-col gap-4">
        {featuredAuthors.length === 0 ? (
          <>
            <SectionHeading
              icon={<Users aria-hidden="true" />}
              title="Featured teachers"
              description="Radiologists publishing on FlowRad."
            />
            <EmptyState
              icon={<Users aria-hidden="true" />}
              title="No teachers yet"
              description="Author profiles will appear here once educators publish."
              action={
                <Link href="/library#teachers">
                  <Button variant="secondary">Open the library</Button>
                </Link>
              }
            />
          </>
        ) : (
          <TeachersRail
            authors={featuredAuthors}
            caseCountByAuthor={caseCountByAuthor}
            courseCountByAuthor={courseCountByAuthor}
            title="Featured teachers"
            description="Radiologists publishing on FlowRad."
            aside={<BrowseAll href="/library#teachers" label="All teachers" />}
          />
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionHeading
          icon={<LayoutGrid aria-hidden="true" />}
          title="Featured cases"
          description="Narrated DICOM studies with an AI tutor."
          aside={<BrowseAll href="/library#cases" label="All cases" />}
        />
        {featuredCases.length === 0 ? (
          <EmptyState
            icon={<LayoutGrid aria-hidden="true" />}
            title="The library is empty"
            description="Published cases will appear here once a teacher publishes their first one."
          />
        ) : (
          <CaseCardGrid cases={featuredCases} authorById={authorById} />
        )}
      </section>

      <section className="flex flex-col items-center gap-4 rounded-xl border border-subtle bg-surface/60 px-6 py-10 text-center">
        <p className="font-display text-lg font-semibold text-primary">Explore the full library</p>
        <p className="max-w-md text-sm text-muted">
          Filter courses, teachers, and cases — or jump straight into a narrated study.
        </p>
        <Link href="/library">
          <Button
            variant="secondary"
            leadingIcon={<GraduationCap className="h-4 w-4" aria-hidden="true" />}
          >
            Open library
          </Button>
        </Link>
      </section>
    </PageContainer>
  );
}
