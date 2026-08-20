// GET /api/assessments/question-view?courseId=…&questionId=…
//
// The imaging payload for a click-the-finding question: the real study the
// finding was authored on, plus just enough viewport state to land the learner
// where the teacher was standing.
//
// WHAT THIS DELIBERATELY DOES NOT RETURN: the target marker, the finding's
// label/description/teaching points, or any other finding on the case. The
// whole point of the question is that the learner localises the abnormality
// themselves, so the answer must never be in the payload — which is why this
// is a dedicated route rather than reusing GET /api/cases/[caseId] (that one
// returns findings with their markers attached).
//
// Grading stays server-side in lib/assessmentGrade.ts; the client only ever
// posts the normalized [0,1] point it captured.

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { getAssessmentForCourse, getCaseForOrg } from "@/lib/cases";
import { resolveCaseSeries } from "@/lib/prefetch";
import { caseSeriesToSource } from "@/lib/viewerSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WADO_RS_ROOT = "/api/dicomweb";

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const orgId = await activeOrgId();

    const courseId = req.nextUrl.searchParams.get("courseId")?.trim();
    const questionId = req.nextUrl.searchParams.get("questionId")?.trim();
    if (!courseId || !questionId) {
      return NextResponse.json(
        { error: "courseId and questionId are required." },
        { status: 400 }
      );
    }

    // Resolve the question from the server-side assessment so a client cannot
    // point this at an arbitrary case/finding pair of its choosing.
    const assessment = await getAssessmentForCourse(orgId, courseId);
    const question = assessment?.questions.find((q) => q.id === questionId);
    if (!question || question.kind !== "click_finding") {
      return NextResponse.json({ error: "Question not found." }, { status: 404 });
    }

    const caseData = await getCaseForOrg(orgId, question.caseId);
    if (!caseData) {
      return NextResponse.json({ error: "Case not found." }, { status: 404 });
    }

    const finding = caseData.findings.find((f) => f.id === question.findingId);

    const series = await resolveCaseSeries(question.caseId, orgId, WADO_RS_ROOT);
    if (!series || series.length === 0) {
      // No imaging resolved (Orthanc off, study missing). Say so plainly so the
      // UI can refuse to grade rather than invent a surface to click on.
      return NextResponse.json({ hasImaging: false, source: null, series: [] });
    }

    // Land on the finding's series when it names one, else the first.
    const index = finding?.seriesInstanceUID
      ? Math.max(
          0,
          series.findIndex((s) => s.seriesInstanceUID === finding.seriesInstanceUID)
        )
      : 0;

    return NextResponse.json({
      hasImaging: true,
      source: caseSeriesToSource(series[index] ?? series[0]),
      series,
      modality: caseData.modality,
      // Viewport only — never the marker.
      view: {
        seriesInstanceUID: finding?.seriesInstanceUID,
        sliceIndex:
          finding?.sliceIndex != null && Number.isFinite(finding.sliceIndex)
            ? finding.sliceIndex
            : undefined,
        windowWidth:
          finding?.windowWidth != null && Number.isFinite(finding.windowWidth)
            ? finding.windowWidth
            : undefined,
        windowCenter:
          finding?.windowCenter != null && Number.isFinite(finding.windowCenter)
            ? finding.windowCenter
            : undefined,
      },
    });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    console.error("[api/assessments/question-view]", err);
    return NextResponse.json(
      { error: "Couldn't load the imaging for this question." },
      { status: 500 }
    );
  }
}
