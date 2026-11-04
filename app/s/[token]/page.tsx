import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedStudyView } from "@/components/account/SharedStudyView";
import { resolveShare } from "@/lib/cloud/access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Shared study · FlowRad Viewer",
  // Share links are private by possession: never index them.
  robots: { index: false, follow: false },
};

export default async function SharePage({ params, searchParams }: { params: { token: string }; searchParams: { study?: string } }) {
  const resolved = await resolveShare(params.token);
  if (!resolved) notFound();
  return <SharedStudyView resolved={resolved} studyId={searchParams.study} />;
}
