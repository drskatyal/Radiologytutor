import Link from "next/link";
import { LayoutGrid, PenLine, Sparkles } from "lucide-react";
import {
  DEFAULT_ORG_ID,
  listAuthors,
  listCasesForOrg,
  listCatalogCases,
  listCourses,
} from "@/lib/cases";
import { Button, PageContainer } from "@/components/ui";
import { TeachZone } from "@/components/home/TeachZone";
import { LearnZone } from "@/components/home/LearnZone";
import { DashboardError } from "@/components/home/DashboardError";
import type { Author, Case } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The Dashboard — the role-aware home. Orients between Learn (the library)
 * and Teach (Studio) instead of dumping the full catalog at "/" (that lives
 * at /library now). Server-rendered; a "Couldn't load your dashboard" state
 * covers a data-layer failure so the page is never blank.
 */
export default async function HomePage() {
  let myCases: Case[] = [];
  let learnCases: Case[] = [];
  let courses: Awaited<ReturnType<typeof listCourses>> = [];
  let authors: Author[] = [];
  let loadError: string | null = null;

  try {
    [myCases, learnCases, courses, authors] = await Promise.all([
      listCasesForOrg(DEFAULT_ORG_ID),
      listCatalogCases(DEFAULT_ORG_ID, { status: "published" }),
      listCourses(DEFAULT_ORG_ID, { status: "published" }),
      listAuthors(DEFAULT_ORG_ID),
    ]);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Something went wrong.";
  }

  const authorById = Object.fromEntries(authors.map((a) => [a.id, a]));

  const stats: { value: number; label: string }[] = [
    { value: learnCases.length, label: learnCases.length === 1 ? "case" : "cases" },
    { value: courses.length, label: courses.length === 1 ? "course" : "courses" },
    { value: authors.length, label: authors.length === 1 ? "author" : "authors" },
  ].filter((s) => s.value > 0);

  return (
    <>
      {/* ── Hero band — orients Learn vs Teach as two equal-weight paths ───── */}
      <section className="relative overflow-hidden border-b border-subtle">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-grid-faint bg-[size:36px_36px] opacity-[0.4] [mask-image:radial-gradient(60rem_30rem_at_50%_-6rem,black,transparent)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[60rem] -translate-x-1/2 rounded-full bg-accent/10 blur-3xl"
        />
        <div className="relative mx-auto max-w-6xl px-6 py-9 sm:px-8 sm:py-11">
          <div className="inline-flex items-center gap-2 rounded-full border border-subtle bg-elevated/60 px-3 py-1 text-xs font-medium text-secondary shadow-sm backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            Your reading-room, on demand
          </div>
          <h1 className="mt-3.5 max-w-2xl font-display text-[1.9rem] font-semibold leading-[1.08] tracking-tightest text-primary sm:text-[2.4rem]">
            Teach and learn radiology,
            <span className="text-accent"> one real study at a time.</span>
          </h1>
          <p className="mt-2.5 max-w-xl text-[0.95rem] leading-relaxed text-secondary">
            Browse narrated DICOM cases with an AI tutor — or open your Studio and teach your own.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link href="/library">
              <Button size="lg" leadingIcon={<LayoutGrid className="h-4 w-4" aria-hidden="true" />}>
                Browse the library
              </Button>
            </Link>
            <Link href="/studio">
              <Button
                size="lg"
                variant="secondary"
                leadingIcon={<PenLine className="h-4 w-4 text-accent" aria-hidden="true" />}
              >
                Open Studio
              </Button>
            </Link>
          </div>

          {stats.length > 0 && (
            <dl className="mt-6 flex flex-wrap items-center gap-x-7 gap-y-3">
              {stats.map((s) => (
                <div key={s.label} className="flex items-baseline gap-1.5">
                  <dt className="sr-only">{s.label}</dt>
                  <dd className="font-display text-lg font-semibold tabular-nums text-primary">{s.value}</dd>
                  <span className="text-sm text-muted">{s.label}</span>
                </div>
              ))}
            </dl>
          )}
        </div>
      </section>

      {loadError ? (
        <DashboardError message={loadError} />
      ) : (
        <PageContainer className="flex flex-col gap-8">
          <TeachZone cases={myCases} />
          <LearnZone cases={learnCases} authorById={authorById} />
        </PageContainer>
      )}
    </>
  );
}
