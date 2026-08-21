import Link from "next/link";
import { ArrowRight, LayoutGrid } from "lucide-react";
import { EmptyState, SectionHeading } from "@/components/ui";
import { CaseCardGrid } from "@/components/catalog/CaseCard";
import type { Author, Case } from "@/lib/types";

/** A rail of recently-published cases plus a "Browse all" link into /library. */
export function LearnZone({ cases, authorById }: { cases: Case[]; authorById: Record<string, Author> }) {
  const rail = cases.slice(0, 6);

  return (
    <section className="flex flex-col gap-4">
      <SectionHeading
        icon={<LayoutGrid aria-hidden="true" />}
        title="Learn"
        description="Narrated DICOM cases from the library, ready to start."
        aside={
          <Link
            href="/library"
            className="inline-flex items-center gap-1 text-sm font-medium text-secondary transition-colors hover:text-accent"
          >
            Browse all
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        }
      />
      {rail.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid aria-hidden="true" />}
          title="The library is empty"
          description="Published cases will appear here once a teacher publishes their first one."
        />
      ) : (
        <CaseCardGrid cases={rail} authorById={authorById} />
      )}
    </section>
  );
}
