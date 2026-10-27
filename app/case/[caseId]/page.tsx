import { notFound } from "next/navigation";
import { activeOrgId, getSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { getAuthor, getCaseForOrg } from "@/lib/cases";
import { seriesHintFromCase } from "@/lib/viewerLoad";
import {
  BUNDLED_CASE,
  caseSeriesToSource,
  type ViewerSource,
} from "@/lib/viewerSource";
import StudentSession from "@/components/student/StudentSession";
import { studentIntentFromQuery } from "@/lib/teacherCapture";
import { RecordCaseOpen } from "@/components/learning/RecordCaseOpen";

export const dynamic = "force-dynamic";

/** WADO-RS root served by our same-origin proxy (creds/CORS handled server-side). */
const WADO_RS_ROOT = "/api/dicomweb";

export default async function CasePage({
  params,
  searchParams,
}: {
  params: { caseId: string };
  searchParams?: { course?: string; mode?: string };
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

  // Series UIDs already on the case. Descriptions and counts arrive in the
  // client from /api/cases/:id/series so HTML does not wait on every series.
  const series = seriesHintFromCase(
    {
      modality: caseData.modality,
      findings: caseData.findings,
      studyRefs: caseData.studyRefs,
    },
    WADO_RS_ROOT
  );
  const author = caseData.authorId ? await getAuthor(orgId, caseData.authorId) : null;

  const source: ViewerSource = series[0] ? caseSeriesToSource(series[0]) : BUNDLED_CASE;
  const imagingResolved = series.length > 0;
  const courseId = searchParams?.course?.trim() || null;
  const tutorVoice =
    author?.voice?.status === "ready" && author.voice.voiceId
      ? { authorName: author.name, cloned: true as const }
      : author
        ? { authorName: author.name, cloned: false as const }
        : null;

  return (
    <>
      <RecordCaseOpen courseId={courseId} caseId={params.caseId} />
      <StudentSession
        caseData={caseData}
        source={source}
        series={series}
        manifest={null}
        imagingResolved={imagingResolved}
        tutorVoice={tutorVoice}
        courseId={courseId}
        initialIntent={studentIntentFromQuery(searchParams?.mode) ?? "teach"}
      />
    </>
  );
}
