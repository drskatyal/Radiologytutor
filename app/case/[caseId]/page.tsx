import { notFound } from "next/navigation";
import { activeOrgId, getSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { getAuthor, getCaseForOrg, listCaseShares } from "@/lib/cases";
import { lastTeacherSlice, seriesHintFromCase } from "@/lib/viewerLoad";
import {
  BUNDLED_CASE,
  caseSeriesToSource,
  type ViewerSource,
} from "@/lib/viewerSource";
import StudentSession from "@/components/student/StudentSession";
import { studentIntentFromQuery } from "@/lib/teacherCapture";
import { RecordCaseOpen } from "@/components/learning/RecordCaseOpen";
import { CaseViewer } from "@/components/library/CaseViewer";
import { ViewerPrewarm } from "@/components/viewer/ViewerPrewarm";
import {
  activeShare,
  caseHasTeachingPack,
  caseOpenMode,
  sharePath,
  studyUidsForCase,
  viewerChrome,
} from "@/lib/caseShare";

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

  const openMode = caseOpenMode(searchParams?.mode);
  const needsAuthorCheck = openMode === "view" || caseData.status !== "published";
  const session = needsAuthorCheck ? await getSession() : null;
  const canAuthor = session
    ? canAccessOrgResource({
        platformRole: session.user.platformRole,
        membershipRole: session.user.membershipRole,
        need: "author",
      })
    : false;

  // Drafts: authors/admins only. Published cases are open for learning.
  if (caseData.status !== "published" && !canAuthor) notFound();

  // Viewer-only. The tutor mounts only for teach / exam. Series hints are the
  // same fast path as teach: HTML does not wait on the archive.
  if (openMode === "view") {
    const series = seriesHintFromCase(
      {
        modality: caseData.modality,
        findings: caseData.findings,
        studyRefs: caseData.studyRefs,
      },
      WADO_RS_ROOT
    );
    const chrome = viewerChrome({
      hasPack: caseHasTeachingPack(caseData),
      canManageShare: canAuthor,
      sharedLink: false,
    });
    const share = canAuthor ? activeShare(await listCaseShares(orgId, params.caseId)) : null;
    return (
      <>
      {/* Engine chunks + the opening frame start now, in parallel with the
          viewer's own code-split download. See lib/viewerWarmup.ts. */}
      <ViewerPrewarm
        series={series[0] ?? null}
        openSlice={lastTeacherSlice(caseData.findings, series[0]?.seriesInstanceUID) ?? null}
      />
      <CaseViewer
        caseId={caseData.caseId}
        title={caseData.title}
        modality={caseData.modality}
        source={series[0] ? caseSeriesToSource(series[0]) : BUNDLED_CASE}
        series={series}
        showTeach={chrome.showTeach}
        showShare={chrome.showShare}
        sharePath={share ? sharePath(share.id) : null}
        sharedLink={false}
        namedStudy={studyUidsForCase(caseData).length > 0}
      />
      </>
    );
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
      <ViewerPrewarm
        series={series[0] ?? null}
        openSlice={lastTeacherSlice(caseData.findings, series[0]?.seriesInstanceUID) ?? null}
      />
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
