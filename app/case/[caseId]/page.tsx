// Student teaching session — /case/[caseId].
//
// Server component: resolves the case (tenant-scoped), builds the prefetch
// manifest, and picks the DICOM source for our self-hosted Cornerstone viewer.
// When the case's imaging resolves from Orthanc we render its first finding's
// series via the same-origin /api/dicomweb (wadors) proxy; otherwise we fall
// back to the bundled offline sample so the viewer always renders (never blank).

import { notFound } from "next/navigation";
import { getCaseForOrg, DEFAULT_ORG_ID } from "@/lib/cases";
import {
  buildPrefetchManifest,
  resolveCaseSeries,
  type PrefetchManifest,
} from "@/lib/prefetch";
import {
  BUNDLED_CASE,
  BUNDLED_CASE_SERIES,
  caseSeriesToSource,
  type CaseSeries,
  type ViewerSource,
} from "@/lib/viewerSource";
import StudentSession from "@/components/student/StudentSession";

export const dynamic = "force-dynamic";

/** WADO-RS root served by our same-origin proxy (creds/CORS handled server-side). */
const WADO_RS_ROOT = "/api/dicomweb";

export default async function CasePage({ params }: { params: { caseId: string } }) {
  const caseData = await getCaseForOrg(DEFAULT_ORG_ID, params.caseId);
  if (!caseData) notFound();

  const manifest = await buildPrefetchManifest(params.caseId, DEFAULT_ORG_ID);

  // Resolve the case's full series rail from Orthanc (via the study). Falls back
  // to the bundled single-series sample so the session always renders the
  // navigator + viewer end to end, even with no imaging backend.
  const resolved = await resolveCaseSeries(params.caseId, DEFAULT_ORG_ID, WADO_RS_ROOT);
  const series: CaseSeries[] =
    resolved && resolved.length > 0 ? resolved : BUNDLED_CASE_SERIES;
  // The first series in the rail is what the case opens on.
  const source: ViewerSource = series[0] ? caseSeriesToSource(series[0]) : BUNDLED_CASE;

  // True only when the case's OWN study resolved from Orthanc. When false we
  // show a neutral sample image but suppress finding markers (they belong to
  // the real study, not the sample) and flag it honestly.
  const imagingResolved = !!resolved && resolved.length > 0;

  return (
    <StudentSession
      caseData={caseData}
      source={source}
      series={series}
      manifest={manifest}
      imagingResolved={imagingResolved}
    />
  );
}
