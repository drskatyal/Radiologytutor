// Studio recording studio — /studio/cases/[caseId]/record (steps 3-4 of the
// create-a-case arc). Server component: loads the case and the series UIDs
// already stored on it. The client asks DICOMweb for the rest of the rail
// after the first frame can start. The bundled sample is only a fallback
// when the case has no series UIDs and the archive list is empty.

import { notFound } from "next/navigation";
import { getCaseForOrg } from "@/lib/cases";
import { activeOrgId } from "@/lib/auth";
import { seriesHintFromCase } from "@/lib/viewerLoad";
import { RecordingStudio } from "@/components/author/RecordingStudio";

export const dynamic = "force-dynamic";

/** WADO-RS root served by our same-origin proxy (creds/CORS handled server-side). */
const WADO_RS_ROOT = "/api/dicomweb";

export default async function StudioRecordPage({ params }: { params: { caseId: string } }) {
  const orgId = await activeOrgId();
  const caseData = await getCaseForOrg(orgId, params.caseId);
  if (!caseData) notFound();

  const series = seriesHintFromCase(
    {
      modality: caseData.modality,
      findings: caseData.findings,
      studyRefs: caseData.studyRefs,
    },
    WADO_RS_ROOT
  );

  return <RecordingStudio initialCase={caseData} initialSeries={series} />;
}
