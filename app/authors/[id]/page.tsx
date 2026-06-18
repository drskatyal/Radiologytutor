import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building2, GraduationCap, LayoutGrid } from "lucide-react";
import {
  DEFAULT_ORG_ID,
  getAuthor,
  listCatalogCases,
  listCourses,
} from "@/lib/cases";
import { Badge, EmptyState } from "@/components/ui";
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
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Library
          </Link>
          {author.institution && (
            <>
              <span className="text-muted">·</span>
              <Badge variant="neutral" className="gap-1.5">
                <Building2 className="h-3 w-3" aria-hidden="true" />
                {author.institution}
              </Badge>
            </>
          )}
          <Badge variant="neutral" className="gap-1.5 tabular-nums">
            <LayoutGrid className="h-3 w-3" aria-hidden="true" />
            {cases.length} case{cases.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </PageHeader>

      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-8">
        {courses.length > 0 && (
          <CoursesRail courses={courses} authorById={{ [author.id]: author }} />
        )}

        <section className="flex flex-col gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight text-primary">
            Cases by {author.name}
          </h2>
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
      </div>
    </>
  );
}
