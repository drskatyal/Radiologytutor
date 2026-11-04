import type { Metadata } from "next";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { AccountShell, requirePageAccount } from "@/components/account/AccountShell";
import { NewCollectionButton } from "@/components/account/CollectionEditor";
import { EmptyState, PageContainer, SectionHeading } from "@/components/ui";
import { viewerStore } from "@/lib/cloud/store";

export const metadata: Metadata = { title: "Collections · FlowRad Viewer" };
export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  const ctx = await requirePageAccount("/collections");
  const collections = await viewerStore().listCollections(ctx.user.id);
  return (
    <AccountShell ctx={ctx}>
      <PageContainer>
        <SectionHeading
          title={<span className="font-display text-4xl font-medium">Collections</span>}
          description="Group studies into a teaching set (an unknowns session, a topic, a course) and share the whole set with one link."
          aside={<NewCollectionButton />}
        />
        {collections.length === 0 ? (
          <EmptyState
            className="mt-8"
            icon={<FolderKanban className="h-6 w-6" aria-hidden />}
            title="No collections yet"
            description="Create a collection, then add studies to it from each study's page."
            action={<NewCollectionButton />}
          />
        ) : (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/collections/${c.id}`}
                  className="flex h-full flex-col rounded-xl border border-subtle bg-surface p-5 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <h3 className="text-lg font-semibold">{c.name}</h3>
                  {c.description && <p className="mt-1 line-clamp-2 text-sm text-secondary">{c.description}</p>}
                  <p className="mt-auto pt-4 text-xs tabular-nums text-muted">
                    {c.studyIds.length} {c.studyIds.length === 1 ? "study" : "studies"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageContainer>
    </AccountShell>
  );
}
