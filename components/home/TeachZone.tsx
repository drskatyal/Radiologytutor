import Link from "next/link";
import { GraduationCap, Mic, PenLine, Play, Plus, Stethoscope } from "lucide-react";
import { Badge, Button, Card, EmptyState, SectionHeading } from "@/components/ui";
import type { Case } from "@/lib/types";

/** Up to 4 most-recently-updated cases, with a context-aware primary action. */
export function TeachZone({ cases }: { cases: Case[] }) {
  const recent = cases.slice(0, 4);

  return (
    <section className="flex flex-col gap-4">
      <SectionHeading
        icon={<PenLine aria-hidden="true" />}
        title="Teach"
        description="Your Studio — cases you're authoring, recording or have published."
        aside={
          <Link href="/studio/new">
            <Button size="sm" leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>
              Create a case
            </Button>
          </Link>
        }
      />

      {recent.length === 0 ? (
        <EmptyState
          icon={<Stethoscope aria-hidden="true" />}
          title="Your Studio is empty"
          description="Upload a study, mark the findings, and record your teaching read — we'll guide every step."
          action={
            <Link href="/studio/new">
              <Button leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>Create a case</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {recent.map((c) => (
            <TeachCard key={c.caseId} c={c} />
          ))}
        </div>
      )}

      {cases.length > 4 && (
        <Link
          href="/studio/cases"
          className="self-start text-xs font-medium text-secondary transition-colors hover:text-accent"
        >
          View all {cases.length} cases →
        </Link>
      )}
    </section>
  );
}

function TeachCard({ c }: { c: Case }) {
  const findingCount = c.findings.length;
  const published = c.status === "published";

  let action: { href: string; label: string; icon: React.ReactNode };
  if (findingCount === 0) {
    action = { href: `/studio/cases/${encodeURIComponent(c.caseId)}/record`, label: "Record findings", icon: <Mic className="h-3.5 w-3.5" aria-hidden="true" /> };
  } else if (!published) {
    action = { href: `/studio/cases/${encodeURIComponent(c.caseId)}`, label: "Review & publish", icon: <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" /> };
  } else {
    action = { href: `/case/${encodeURIComponent(c.caseId)}`, label: "Preview", icon: <Play className="h-3.5 w-3.5" aria-hidden="true" /> };
  }

  return (
    <Card className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-primary">{c.title}</h3>
        <Badge variant={published ? "success" : "warning"}>{c.status}</Badge>
      </div>
      <Badge variant={findingCount > 0 ? "accent" : "neutral"} className="self-start">
        {findingCount} finding{findingCount === 1 ? "" : "s"}
      </Badge>
      <Link href={action.href} className="mt-auto">
        <Button size="sm" variant="secondary" leadingIcon={action.icon} className="w-full">
          {action.label}
        </Button>
      </Link>
    </Card>
  );
}
