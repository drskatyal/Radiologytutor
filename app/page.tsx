import { Suspense } from "react";
import Link from "next/link";
import { Mic, Sparkles, Workflow } from "lucide-react";
import {
  DEFAULT_ORG_ID,
  listCatalogCases,
  getCatalogFacets,
  listAuthors,
  listCourses,
  listPlaylists,
} from "@/lib/cases";
import { Button, PageContainer, Skeleton } from "@/components/ui";
import { Catalog } from "@/components/catalog/Catalog";
import type { CatalogResponse } from "@/components/catalog/types";
import CasesPrefetcher from "@/components/CasesPrefetcher";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // The catalog is the library landing. Load the unfiltered, published view
  // server-side so the page renders instantly; the client takes over filtering.
  const [cases, facets, authors, courses, playlists] = await Promise.all([
    listCatalogCases(DEFAULT_ORG_ID, { status: "published" }),
    getCatalogFacets(DEFAULT_ORG_ID),
    listAuthors(DEFAULT_ORG_ID),
    listCourses(DEFAULT_ORG_ID, { status: "published" }),
    listPlaylists(DEFAULT_ORG_ID),
  ]);

  const initial: CatalogResponse = { cases, facets, authors, courses, playlists };
  const firstCaseId = cases[0]?.caseId;

  // Tight, factual orientation stats — give the hero substance instead of a void.
  const stats: { value: number; label: string }[] = [
    { value: cases.length, label: cases.length === 1 ? "case" : "cases" },
    { value: courses.length, label: courses.length === 1 ? "course" : "courses" },
    { value: authors.length, label: authors.length === 1 ? "author" : "authors" },
  ].filter((s) => s.value > 0);

  return (
    <>
      {/* ── Hero band — compact, orienting, not dominating ─────────────────── */}
      <section className="relative overflow-hidden border-b border-subtle">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-grid-faint bg-[size:36px_36px] opacity-[0.4] [mask-image:radial-gradient(60rem_30rem_at_50%_-6rem,black,transparent)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[60rem] -translate-x-1/2 rounded-full bg-accent/10 blur-3xl"
        />
        <div className="relative mx-auto max-w-6xl px-6 py-12 sm:px-8 sm:py-14">
          <div className="inline-flex items-center gap-2 rounded-full border border-subtle bg-elevated/60 px-3 py-1 text-xs font-medium text-secondary shadow-sm backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            A teaching library, narrated by an AI tutor
          </div>
          <h1 className="mt-4 max-w-3xl font-display text-[2rem] font-semibold leading-[1.08] tracking-tightest text-primary sm:text-[2.75rem]">
            Read every study like the
            <span className="text-accent"> attending is beside you.</span>
          </h1>
          <p className="mt-3 max-w-xl text-base leading-relaxed text-secondary">
            Browse a curated library of real DICOM cases by system and difficulty,
            follow guided multi-step walk-throughs, and ask the tutor anything by
            voice.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {firstCaseId && (
              <Link href={`/case/${firstCaseId}`}>
                <Button
                  size="lg"
                  trailingIcon={<Workflow className="h-4 w-4" aria-hidden="true" />}
                >
                  Start a case
                </Button>
              </Link>
            )}
            <Link href="/author">
              <Button
                size="lg"
                variant="secondary"
                leadingIcon={<Mic className="h-4 w-4 text-accent" aria-hidden="true" />}
              >
                Author a case
              </Button>
            </Link>
          </div>

          {stats.length > 0 && (
            <dl className="mt-7 flex flex-wrap items-center gap-x-7 gap-y-3">
              {stats.map((s) => (
                <div key={s.label} className="flex items-baseline gap-1.5">
                  <dt className="sr-only">{s.label}</dt>
                  <dd className="font-display text-lg font-semibold tabular-nums text-primary">
                    {s.value}
                  </dd>
                  <span className="text-sm text-muted">{s.label}</span>
                </div>
              ))}
            </dl>
          )}
        </div>
      </section>

      {/* ── The library catalog ────────────────────────────────────────────── */}
      <PageContainer>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Catalog initial={initial} />
        </Suspense>
      </PageContainer>

      <CasesPrefetcher caseIds={cases.map((c) => c.caseId)} />
    </>
  );
}
