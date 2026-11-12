import { findActiveExam } from "@/lib/cases";
import { isExamMode } from "@/lib/exam/projection";
import { startExam, submitExamAnswer } from "@/lib/exam/service";
// POST /api/grade-report
// Body: { caseId, report: string }
// Reply: ReportGrade — rubric is always present, even when Gemini is off.

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { geminiConfigured, generate, parseJsonLoose } from "@/lib/gemini";
import { getCaseForOrg, groundedCase } from "@/lib/cases";
import {
  GRADE_REPORT_SYSTEM,
  buildReportRubric,
  localReportGrade,
  normalizeReportGrade,
  type ReportGrade,
} from "@/lib/reportGrade";

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
    const stored = await getCaseForOrg(orgId, caseId);
    const data = stored ? await groundedCase(stored) : null;
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

    const active = await findActiveExam(orgId, user.id, caseId);
    if (active || isExamMode(body.mode)) {
      const attempt = active ?? await startExam(orgId, user.id, caseId);
      if (!report) return NextResponse.json({ error: "Report required" }, { status: 400 });
      return NextResponse.json({ mode: "exam", ...await submitExamAnswer(orgId, user.id, attempt.id, { kind: "report", text: report }, body.close === true) });
    }
    const rubric = buildReportRubric(data.findings);
    if (!report) {
      const empty = localReportGrade("", rubric);
      return NextResponse.json({
        mode: "practice",
        ...empty,
        bands: empty.bands.map((band, index) =>
          index === 0 ? { ...band, comment: "Dictate findings before grading." } : band
        ),
      });
    }

    if (!geminiConfigured()) {
      return NextResponse.json(
        {
          error: "The AI grader is unavailable — GEMINI_API_KEY is not set.",
          mode: "practice",
          fallback: true,
          grade: localReportGrade(report, rubric),
        },
        { status: 503 }
      );
    }

    let result;
    try {
      result = await generate({
        systemInstruction: GRADE_REPORT_SYSTEM,
        temperature: 0.2,
        jsonOnly: true,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `RUBRIC:\n${JSON.stringify(rubric, null, 2)}\n\nTRAINEE REPORT:\n${report}`,
              },
            ],
          },
        ],
      });
    } catch (err) {
      console.error("[api/grade-report]", err);
      return NextResponse.json(
        {
          error: "The grader is unavailable right now.",
          mode: "practice",
          fallback: true,
          grade: localReportGrade(report, rubric),
        },
        { status: 502 }
      );
    }

    const parsed = parseJsonLoose<Partial<ReportGrade>>(result.text);
    return NextResponse.json({ mode: "practice", ...normalizeReportGrade(parsed, rubric, report) });
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    console.error("[api/grade-report]", err);
    return NextResponse.json({ error: "The grader is unavailable right now." }, { status: 502 });
  }
}
