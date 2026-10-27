import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CaseViewer } from "@/components/library/CaseViewer";
import { getCaseForOrg, resolveShareAccess } from "@/lib/cases";
import { isShareToken, studyUidsForCase, viewerChrome } from "@/lib/caseShare";
import { seriesHintFromCase } from "@/lib/viewerLoad";
import { BUNDLED_CASE, caseSeriesToSource } from "@/lib/viewerSource";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { token: string };
}): Promise<Metadata> {
  if (!isShareToken(params.token)) {
    return { title: "Shared study · RadLearn", robots: { index: false, follow: false } };
  }
  const access = await resolveShareAccess(params.token);
  const caseData = access ? await getCaseForOrg(access.orgId, access.caseId) : null;
  return {
    title: caseData ? `${caseData.title} · RadLearn` : "Shared study · RadLearn",
    robots: { index: false, follow: false },
  };
}

/**
 * Pacsbin-style share. The token is the credential. Middleware plants an
 * httpOnly cookie so the viewer can read this case's studies without an account.
 * Revoked and unknown tokens 404. This page never starts Teach.
 */
export default async function SharedCasePage({ params }: { params: { token: string } }) {
  if (!isShareToken(params.token)) notFound();
  const access = await resolveShareAccess(params.token);
  if (!access) notFound();
  const caseData = await getCaseForOrg(access.orgId, access.caseId);
  if (!caseData) notFound();

  const series = seriesHintFromCase(
    {
      modality: caseData.modality,
      findings: caseData.findings,
      studyRefs: caseData.studyRefs,
    },
    "/api/dicomweb"
  );
  const chrome = viewerChrome({
    hasPack: false,
    canManageShare: false,
    sharedLink: true,
  });

  return (
    <CaseViewer
      caseId={caseData.caseId}
      title={caseData.title}
      modality={caseData.modality}
      source={series[0] ? caseSeriesToSource(series[0]) : BUNDLED_CASE}
      series={series}
      showTeach={chrome.showTeach}
      showShare={chrome.showShare}
      sharePath={null}
      sharedLink
      namedStudy={studyUidsForCase(caseData).length > 0}
    />
  );
}
