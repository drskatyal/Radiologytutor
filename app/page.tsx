import Link from "next/link";
import { listCasesForOrg, DEFAULT_ORG_ID } from "@/lib/cases";
import { Badge, Card, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
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
      <PageHeader
        title="Teaching cases"
        description="Pick a case for a guided, voice-narrated walk-through with the AI tutor."
      />

      <div className="mx-auto max-w-5xl px-6 py-8">
        {visible.length === 0 ? (
          <EmptyState
            title="No cases yet"
            description="Upload a study and build your first teaching case."
            action={
              <Link
                href="/admin"
                className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:opacity-90"
              >
                Go to Admin
              </Link>
            }
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((c, i) => (
              <li
                key={c.caseId}
                className="animate-[fade-up_0.4s_ease-out_both]"
                style={{ animationDelay: `${Math.min(i * 50, 400)}ms` }}
              >
                <Link href={`/case/${c.caseId}`} className="group block h-full">
                  <Card className="flex h-full flex-col gap-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-base font-semibold text-primary">{c.title}</h3>
                      {c.status === "draft" && (
                        <Badge variant="warning">Draft</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="info">{c.modality || "—"}</Badge>
                      {c.specialty && <Badge>{c.specialty}</Badge>}
                    </div>
                    <div className="mt-auto flex items-center justify-between pt-2 text-sm text-muted">
                      <span className="tabular-nums">
                        {c.findings.length} finding{c.findings.length === 1 ? "" : "s"}
                      </span>
                      <span className="inline-flex items-center gap-1 font-medium text-secondary transition-colors group-hover:text-accent">
                        Start
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5">
                          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CasesPrefetcher caseIds={visible.map((c) => c.caseId)} />
    </>
  );
}
