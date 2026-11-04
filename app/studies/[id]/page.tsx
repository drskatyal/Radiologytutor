import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell, requirePageAccount } from "@/components/account/AccountShell";
import { StudyWorkspace } from "@/components/account/StudyWorkspace";
import { viewerStore } from "@/lib/cloud/store";

export const metadata: Metadata = { title: "Study · FlowRad Viewer" };
export const dynamic = "force-dynamic";

export default async function StudyPage({ params }: { params: { id: string } }) {
  const ctx = await requirePageAccount(`/studies/${params.id}`);
  const store = viewerStore();
  const study = await store.getStudy(params.id);
  if (!study || study.ownerId !== ctx.user.id) notFound();
  const [shares, collections] = await Promise.all([store.listShares(ctx.user.id), store.listCollections(ctx.user.id)]);
  return (
    <AccountShell ctx={ctx}>
      <StudyWorkspace
        initialStudy={study}
        initialShares={shares.filter((s) => s.target.kind === "study" && s.target.studyId === study.id)}
        collections={collections.map((c) => ({ id: c.id, name: c.name, hasStudy: c.studyIds.includes(study.id) }))}
      />
    </AccountShell>
  );
}
