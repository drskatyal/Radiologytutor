// Server-side report grading: Gemini against the authored rubric, with the
// local phrase-coverage grade as the fallback. One place for the call so the
// Report Coach (/api/grade-report) and the post-test (/api/attempts) grade a
// report the same way. Server-only — reads GEMINI_API_KEY through lib/gemini.

import { geminiConfigured, generate, parseJsonLoose } from "./gemini";
import {
  GRADE_REPORT_SYSTEM,
  localReportGrade,
  normalizeReportGrade,
  type ReportGrade,
  type ReportRubricItem,
} from "./reportGrade";

export type ReportGradeOutcome =
  | { gradedBy: "model"; grade: ReportGrade }
  | { gradedBy: "local"; grade: ReportGrade; reason: "unconfigured" | "unavailable" };

export async function gradeReportText(
  report: string,
  rubric: ReportRubricItem[]
): Promise<ReportGradeOutcome> {
  if (!report.trim()) {
    return { gradedBy: "local", grade: localReportGrade("", rubric), reason: "unavailable" };
  }
  if (!geminiConfigured()) {
    return { gradedBy: "local", grade: localReportGrade(report, rubric), reason: "unconfigured" };
  }
  try {
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
    return { gradedBy: "model", grade: normalizeReportGrade(parsed, rubric, report) };
  } catch (err) {
    console.error("[reportGradeServer]", err instanceof Error ? err.message : "grader error");
    return { gradedBy: "local", grade: localReportGrade(report, rubric), reason: "unavailable" };
  }
}
