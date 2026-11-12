// POST /api/attempts — submit answers for an assessment; returns the graded
// Attempt plus a review (answer keys only when the attempt passed; report
// questions always carry their rubric).

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { getAssessment, submitAttempt } from "@/lib/cases";
import {
  reportOverallForAttempt,
  reportPassMark,
  reviewAttempt,
  type LearnerAnswer,
} from "@/lib/assessmentGrade";
import { buildQuestionRubric } from "@/lib/reportGrade";
import { gradeReportText } from "@/lib/reportGradeServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Report questions call the model; give a multi-report post-test room.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const orgId = await activeOrgId();
    const body = (await req.json()) as {
      assessmentId?: string;
      answers?: LearnerAnswer[];
    };
    const assessmentId = body.assessmentId?.trim();
    if (!assessmentId) {
      return NextResponse.json({ error: "assessmentId is required." }, { status: 400 });
    }
    if (!Array.isArray(body.answers)) {
      return NextResponse.json({ error: "answers must be an array." }, { status: 400 });
    }

    const attempt = await submitAttempt({
      userId: session.id,
      orgId,
      assessmentId,
      answers: body.answers,
      gradeReport: async ({ question, caseData, text }) => {
        // A missing case can't be graded fairly — no credit, no fabricated rubric.
        if (!caseData || caseData.findings.length === 0) return null;
        const rubric = buildQuestionRubric(caseData.findings, question.findingIds);
        const outcome = await gradeReportText(text, rubric);
        return {
          overall: reportOverallForAttempt(outcome.gradedBy, outcome.grade),
          passMark: reportPassMark(question),
          gradedBy: outcome.gradedBy,
          bands: outcome.grade.bands,
          modelImpression: outcome.grade.modelImpression,
          items: outcome.grade.items,
          rubric: outcome.grade.rubric,
        };
      },
    });
    const assessment = await getAssessment(assessmentId);
    const review = assessment ? reviewAttempt(assessment.questions, attempt) : null;
    return NextResponse.json({ attempt, review });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
