// Author recording studio — /author/record/[caseId].
//
// Server component: resolves the case (tenant-scoped) + its full series rail
// from Orthanc, then hands both to the client RecordingStudio. Mirrors the
// student page's series resolution so the author records against the SAME
// navigator the learner sees. Falls back to the bundled sample when imaging
// isn't resolved, so the studio always renders end to end.

import { notFound } from "next/navigation";
import { getCaseForOrg, DEFAULT_ORG_ID } from "@/lib/cases";
import { resolveCaseSeries } from "@/lib/prefetch";
import type { CaseSeries } from "@/lib/viewerSource";
import { RecordingStudio } from "@/components/author/RecordingStudio";

export const dynamic = "force-dynamic";

/** WADO-RS root served by our same-origin proxy (creds/CORS handled server-side). */
const WADO_RS_ROOT = "/api/dicomweb";

export default async function RecordPage({ params }: { params: { caseId: string } }) {
  const caseData = await getCaseForOrg(DEFAULT_ORG_ID, params.caseId);
  if (!caseData) notFound();

  // Empty when imaging can't be resolved — the studio falls back to the sample.
  const resolved = await resolveCaseSeries(params.caseId, DEFAULT_ORG_ID, WADO_RS_ROOT);
  const series: CaseSeries[] = resolved && resolved.length > 0 ? resolved : [];

  return <RecordingStudio initialCase={caseData} initialSeries={series} />;
}
