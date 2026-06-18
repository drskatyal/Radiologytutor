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
import { Skeleton } from "@/components/ui";
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

  return (
    <>
      {/* ── Flagship hero band ─────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-subtle">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-grid-faint bg-[size:36px_36px] opacity-[0.4] [mask-image:radial-gradient(60rem_30rem_at_50%_-6rem,black,transparent)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[60rem] -translate-x-1/2 rounded-full bg-accent/10 blur-3xl"
        />
        <div className="relative mx-auto max-w-6xl px-6 py-16 sm:py-20">
          <div className="inline-flex items-center gap-2 rounded-full border border-subtle bg-elevated/60 px-3 py-1 text-xs font-medium text-secondary shadow-sm backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            A teaching library, narrated by an AI tutor
          </div>
          <h1 className="mt-5 max-w-3xl font-display text-4xl font-semibold leading-[1.08] tracking-tightest text-primary sm:text-5xl">
            Read every study like the
            <span className="text-accent"> attending is beside you.</span>
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-secondary">
            Browse a curated library of real DICOM cases by system and difficulty,
            follow guided multi-step walk-throughs, and ask the tutor anything by
            voice.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            {firstCaseId && (
              <Link
                href={`/case/${firstCaseId}`}
                className="group inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-medium text-accent-foreground shadow-sm transition-[box-shadow,filter] hover:shadow-glow hover:brightness-[1.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                Start a case
                <Workflow className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            )}
            <Link
              href="/author"
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-strong bg-elevated px-5 text-sm font-medium text-primary shadow-sm transition-colors hover:border-accent/40 hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              <Mic className="h-4 w-4 text-accent" />
              Author a case
            </Link>
          </div>
        </div>
      </section>

      {/* ── The library catalog ────────────────────────────────────────────── */}
      <div className="mx-auto max-w-6xl px-6 py-10">
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Catalog initial={initial} />
        </Suspense>
      </div>

      <CasesPrefetcher caseIds={cases.map((c) => c.caseId)} />
    </>
  );
}
