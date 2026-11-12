// POST /api/grade-report
// Body: { caseId, report: string }
// Reply: ReportGrade — rubric is always present, even when Gemini is off.

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { getCaseForOrg } from "@/lib/cases";
import { buildReportRubric, localReportGrade } from "@/lib/reportGrade";
import { gradeReportText } from "@/lib/reportGradeServer";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Grading reads the case's rubric-bearing findings and spends Gemini quota:
    // authenticated, org-scoped, draft-gated like the tutor route.
    const user = await requireSession();
    const orgId = await activeOrgId();

    const body = await req.json();
    const caseId = String(body.caseId ?? "");
    const report = String(body.report ?? "").trim();
    const data = await getCaseForOrg(orgId, caseId);
    if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });

    if (
      data.status !== "published" &&
      !canAccessOrgResource({
        platformRole: user.platformRole,
        membershipRole: user.membershipRole,
        need: "author",
      })
    ) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    const rubric = buildReportRubric(data.findings);
    if (!report) {
      const empty = localReportGrade("", rubric);
      return NextResponse.json({
        ...empty,
        bands: empty.bands.map((band, index) =>
          index === 0 ? { ...band, comment: "Dictate findings before grading." } : band
        ),
      });
    }

    const outcome = await gradeReportText(report, rubric);
    if (outcome.gradedBy === "local") {
      return NextResponse.json(
        {
          error:
            outcome.reason === "unconfigured"
              ? "The AI grader is unavailable — GEMINI_API_KEY is not set."
              : "The grader is unavailable right now.",
          fallback: true,
          grade: outcome.grade,
        },
        { status: outcome.reason === "unconfigured" ? 503 : 502 }
      );
    }
    return NextResponse.json(outcome.grade);
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    console.error("[api/grade-report]", err);
    return NextResponse.json({ error: "The grader is unavailable right now." }, { status: 502 });
  }
}
