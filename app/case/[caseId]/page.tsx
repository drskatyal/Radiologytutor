// Student teaching session — /case/[caseId].
//
// Server component: resolves the case (tenant-scoped), builds the prefetch
// manifest, and picks the DICOM source for our self-hosted Cornerstone viewer.
// When the case's imaging resolves from Orthanc we render its first finding's
// series via the same-origin /api/dicomweb (wadors) proxy; otherwise we fall
// back to the bundled offline sample so the viewer always renders (never blank).

import { notFound } from "next/navigation";
import { getCaseForOrg, DEFAULT_ORG_ID } from "@/lib/cases";
import { buildPrefetchManifest, type PrefetchManifest } from "@/lib/prefetch";
import { BUNDLED_CASE, type ViewerSource } from "@/lib/viewerSource";
import StudentSession from "@/components/student/StudentSession";

export const dynamic = "force-dynamic";

/** WADO-RS root served by our same-origin proxy (creds/CORS handled server-side). */
const WADO_RS_ROOT = "/api/dicomweb";

/**
 * Pick the viewer source. Prefer the case's first prefetch series (real DICOM
 * via the proxy); fall back to the bundled sample when Orthanc isn't wired up
 * so the session still renders end to end.
 */
function resolveSource(manifest: PrefetchManifest | null): ViewerSource {
  if (manifest?.hasImaging) {
    const first = manifest.series.find((s) => s.studyInstanceUID && s.seriesInstanceUID);
    if (first) {
      return {
        kind: "wadors",
        wadoRsRoot: WADO_RS_ROOT,
        StudyInstanceUID: first.studyInstanceUID,
        SeriesInstanceUID: first.seriesInstanceUID,
      };
    }
  }
  return BUNDLED_CASE;
}

export default async function CasePage({ params }: { params: { caseId: string } }) {
  const caseData = await getCaseForOrg(DEFAULT_ORG_ID, params.caseId);
  if (!caseData) notFound();

  const manifest = await buildPrefetchManifest(params.caseId, DEFAULT_ORG_ID);
  const source = resolveSource(manifest);
  // True only when the case's OWN study resolved from Orthanc. When false we
  // show a neutral sample image but suppress finding markers (they belong to
  // the real study, not the sample) and flag it honestly.
  const imagingResolved = manifest?.hasImaging ?? false;

  return (
    <StudentSession
      caseData={caseData}
      source={source}
      manifest={manifest}
      imagingResolved={imagingResolved}
    />
  );
}
