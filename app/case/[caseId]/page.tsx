import { notFound } from "next/navigation";
import { getCase } from "@/lib/cases";
import PlaybackClient from "@/components/PlaybackClient";

export const dynamic = "force-dynamic";

export default async function CasePage({ params }: { params: { caseId: string } }) {
  const data = await getCase(params.caseId);
  if (!data) notFound();
  return <PlaybackClient caseData={data} />;
}
