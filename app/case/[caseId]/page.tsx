import { notFound } from "next/navigation";
import { activeOrgId, getSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { getCaseForOrg } from "@/lib/cases";
import {
  buildPrefetchManifest,
  resolveCaseSeries,
} from "@/lib/prefetch";
import {
  BUNDLED_CASE,
  BUNDLED_CASE_SERIES,
  caseSeriesToSource,
  type CaseSeries,
  type ViewerSource,
} from "@/lib/viewerSource";
import StudentSession from "@/components/student/StudentSession";
import { RecordCaseOpen } from "@/components/learning/RecordCaseOpen";

export const dynamic = "force-dynamic";

/** WADO-RS root served by our same-origin proxy (creds/CORS handled server-side). */
const WADO_RS_ROOT = "/api/dicomweb";

export default async function CasePage({
  params,
  searchParams,
}: {
  params: { caseId: string };
  searchParams?: { course?: string };
}) {
  const orgId = await activeOrgId();
  const caseData = await getCaseForOrg(orgId, params.caseId);
  if (!caseData) notFound();

  // Drafts: authors/admins only. Published cases are open for learning.
  if (caseData.status !== "published") {
    const session = await getSession();
    const canAuthor = session
      ? canAccessOrgResource({
          platformRole: session.user.platformRole,
          membershipRole: session.user.membershipRole,
          need: "author",
        })
      : false;
    if (!canAuthor) notFound();
  }

  const [manifest, resolved] = await Promise.all([
    buildPrefetchManifest(params.caseId, orgId),
    resolveCaseSeries(params.caseId, orgId, WADO_RS_ROOT),
  ]);

  const series: CaseSeries[] =
    resolved && resolved.length > 0 ? resolved : BUNDLED_CASE_SERIES;
  const source: ViewerSource = series[0] ? caseSeriesToSource(series[0]) : BUNDLED_CASE;
  const imagingResolved = !!resolved && resolved.length > 0;
  const courseId = searchParams?.course?.trim() || null;

  return (
    <>
      <RecordCaseOpen courseId={courseId} caseId={params.caseId} />
      <StudentSession
        caseData={caseData}
        source={source}
        series={series}
        manifest={manifest}
        imagingResolved={imagingResolved}
      />
    </>
  );
}
