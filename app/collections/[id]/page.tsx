import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AccountShell, requirePageAccount } from "@/components/account/AccountShell";
import { CollectionEditor } from "@/components/account/CollectionEditor";
import { SharePanel } from "@/components/account/SharePanel";
import { PageContainer, Panel } from "@/components/ui";
import { viewerStore } from "@/lib/cloud/store";

export const metadata: Metadata = { title: "Collection · FlowRad Viewer" };
export const dynamic = "force-dynamic";

export default async function CollectionPage({ params }: { params: { id: string } }) {
  const ctx = await requirePageAccount(`/collections/${params.id}`);
  const store = viewerStore();
  const collection = await store.getCollection(params.id);
  if (!collection || collection.ownerId !== ctx.user.id) notFound();
  const [studies, shares] = await Promise.all([store.listStudies(ctx.user.id), store.listShares(ctx.user.id)]);
  return (
    <AccountShell ctx={ctx}>
      <PageContainer>
        <Link href="/collections" className="inline-flex items-center gap-1 rounded text-sm font-medium text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Collections
        </Link>
        <h1 className="mt-2 font-display text-4xl font-medium tracking-tight">{collection.name}</h1>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <CollectionEditor initial={collection} studies={studies.map((s) => ({ id: s.id, title: s.title, modality: s.modality }))} />
          <Panel title="Share this collection" className="h-fit">
            <SharePanel
              target={{ collectionId: collection.id }}
              initialShares={shares.filter((s) => s.target.kind === "collection" && s.target.collectionId === collection.id)}
              disabledReason={collection.studyIds.length ? undefined : "Add a study before sharing."}
            />
          </Panel>
        </div>
      </PageContainer>
    </AccountShell>
  );
}
