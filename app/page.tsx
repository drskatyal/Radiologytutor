import Link from "next/link";
import { Mic, Sparkles, Workflow } from "lucide-react";
import { listCasesForOrg, DEFAULT_ORG_ID } from "@/lib/cases";
import { EmptyState } from "@/components/ui";
import { CaseGrid } from "@/components/CaseGrid";
import CasesPrefetcher from "@/components/CasesPrefetcher";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cases = await listCasesForOrg(DEFAULT_ORG_ID);
  // Students see published teaching cases; fall back to all if none published
  // yet (fresh demo).
  const published = cases.filter((c) => c.status === "published");
  const visible = published.length > 0 ? published : cases;

  return (
    <>
      {/* ── Flagship hero band ─────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-subtle">
        {/* Layered ambience: faint grid + accent glow, all subtle. */}
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
            Voice-narrated teaching, powered by an AI tutor
          </div>
          <h1 className="mt-5 max-w-3xl font-display text-4xl font-semibold leading-[1.08] tracking-tightest text-primary sm:text-5xl">
            Read every study like the
            <span className="text-accent"> attending is beside you.</span>
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-secondary">
            FlowRad Learn replays real DICOM cases as guided, multi-step
            walk-throughs — the viewer animates to each finding while the tutor
            narrates and answers your questions by voice.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            {visible.length > 0 && (
              <Link
                href={`/case/${visible[0].caseId}`}
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

      {/* ── Case library ───────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight text-primary">
            Teaching cases
          </h2>
          {visible.length > 0 && (
            <span className="text-sm tabular-nums text-muted">
              {visible.length} available
            </span>
          )}
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={<Workflow />}
            title="No cases yet"
            description="Upload a study and build your first teaching case to see it here."
            action={
              <Link
                href="/admin"
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground shadow-sm transition-[box-shadow,filter] hover:shadow-glow hover:brightness-[1.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                Go to Admin
              </Link>
            }
          />
        ) : (
          <CaseGrid
            cases={visible.map((c) => ({
              caseId: c.caseId,
              title: c.title,
              modality: c.modality,
              specialty: c.specialty,
              status: c.status,
              findingCount: c.findings.length,
            }))}
          />
        )}
      </div>

      <CasesPrefetcher caseIds={visible.map((c) => c.caseId)} />
    </>
  );
}
