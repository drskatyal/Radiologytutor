// POST /api/grade-report
// Body: { caseId, report: string }
// Reply: ReportGrade — rubric is always present, even when Gemini is off.

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { geminiConfigured, generate, parseJsonLoose } from "@/lib/gemini";
import { getCaseForOrg } from "@/lib/cases";
import {
  GRADE_REPORT_SYSTEM,
  buildReportRubric,
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
      return NextResponse.json(
        normalizeReportGrade(
          {
            overall: 0,
            missed: rubric.map((r) => r.label),
            modelImpression: "",
            bands: [
              {
                name: "Findings",
                score: 0,
                max: 50,
                comment: "Dictate findings before grading.",
              },
            ],
          },
          rubric
        )
      );
    }

    if (!geminiConfigured()) {
      return NextResponse.json(
        {
          error: "The AI grader is unavailable — GEMINI_API_KEY is not set.",
          fallback: true,
          grade: normalizeReportGrade(
            {
              overall: 0,
              missed: rubric.map((r) => r.label),
              modelImpression: "",
              bands: [
                {
                  name: "Findings",
                  score: 0,
                  max: 50,
                  comment: "Grader is offline. Use the rubric to self-check.",
                },
              ],
            },
            rubric
          ),
        },
        { status: 503 }
      );
    }

    const result = await generate({
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

    const parsed = parseJsonLoose<Partial<ReportGrade>>(result.text);
    return NextResponse.json(normalizeReportGrade(parsed, rubric));
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    console.error("[api/grade-report]", err);
    return NextResponse.json({ error: "The grader is unavailable right now." }, { status: 502 });
  }
}
