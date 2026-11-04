import type { Metadata } from "next";
import { Link2 } from "lucide-react";
import { AccountShell, requirePageAccount } from "@/components/account/AccountShell";
import { LinksTable } from "@/components/account/LinksTable";
import { EmptyState, PageContainer, SectionHeading } from "@/components/ui";
import { viewerStore } from "@/lib/cloud/store";

export const metadata: Metadata = { title: "Shared links · FlowRad Viewer" };
export const dynamic = "force-dynamic";

export default async function LinksPage() {
  const ctx = await requirePageAccount("/links");
  const store = viewerStore();
  const [shares, studies, collections] = await Promise.all([store.listShares(ctx.user.id), store.listStudies(ctx.user.id), store.listCollections(ctx.user.id)]);
  const names: Record<string, string> = {};
  for (const s of studies) names[`study:${s.id}`] = s.title;
  for (const c of collections) names[`collection:${c.id}`] = `${c.name} (collection)`;
  return (
    <AccountShell ctx={ctx}>
      <PageContainer>
        <SectionHeading
          title={<span className="font-display text-4xl font-medium">Shared links</span>}
          description="Every view-only link you have made. Revoke one and it stops working within seconds."
        />
        {shares.length === 0 ? (
          <EmptyState className="mt-8" icon={<Link2 className="h-6 w-6" aria-hidden />} title="No links yet" description="Share a study or a collection from its page." />
        ) : (
          <LinksTable
            initial={shares.map((s) => ({
              ...s,
              targetName: names[s.target.kind === "study" ? `study:${s.target.studyId}` : `collection:${s.target.collectionId}`] ?? "Deleted",
              href: s.target.kind === "study" ? `/studies/${s.target.studyId}` : `/collections/${s.target.collectionId}`,
            }))}
          />
        )}
      </PageContainer>
    </AccountShell>
  );
}
