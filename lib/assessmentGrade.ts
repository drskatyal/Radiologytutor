// Grading for assessment questions.
//
// MCQ and click-the-finding are deterministic and graded here. Report
// questions are graded by the caller (Gemini via lib/reportGradeServer.ts, or
// the local phrase-coverage fallback) and handed in as `reportGrades`, so this
// module stays pure and testable. A report earns partial credit: its rubric
// score / 100.

import { clickDistance, clickHitsFinding, DEFAULT_HIT_RADIUS } from "./clickFinding";
import type {
  Attempt,
  AttemptReportGrade,
  AttemptResponse,
  ClickFindingQuestion,
  Marker,
  McqQuestion,
  Question,
  ReportQuestion,
} from "./types";

export type LearnerAnswer = {
  questionId: string;
  selectedIndex?: number;
  x_pct?: number;
  y_pct?: number;
  text?: string;
};

/** Longest report we grade. Longer text is cut, not rejected. */
export const MAX_REPORT_CHARS = 4000;

/** Default report score a learner needs for the question to count as correct. */
export const DEFAULT_REPORT_PASS_MARK = 60;

export function reportPassMark(question: ReportQuestion): number {
  const mark = question.passMark;
  if (typeof mark !== "number" || !Number.isFinite(mark)) return DEFAULT_REPORT_PASS_MARK;
  return Math.min(100, Math.max(0, Math.round(mark)));
}

/**
 * The report score that counts toward the post-test. The model grades
 * findings, impression and language out of 100. The offline fallback can only
 * score findings (out of 50), so it is scaled to 100 — otherwise a grader
 * outage would make every report pass mark unreachable.
 */
export function reportOverallForAttempt(
  gradedBy: "model" | "local",
  grade: { overall: number; bands: Array<{ name: string; score: number; max: number }> }
): number {
  if (gradedBy === "model") return clampScore(grade.overall);
  const findings = grade.bands.find((b) => b.name === "Findings") ?? grade.bands[0];
  if (!findings || findings.max <= 0) return 0;
  return clampScore((findings.score / findings.max) * 100);
}

/** Trim and cap a learner's report before it is graded or stored. */
export function cleanReportText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, MAX_REPORT_CHARS);
}

export function gradeMcq(question: McqQuestion, selectedIndex: number | undefined): boolean {
  if (selectedIndex === undefined || !Number.isInteger(selectedIndex)) return false;
  return selectedIndex === question.correctIndex;
}

export function gradeClickFinding(
  question: ClickFindingQuestion,
  x_pct: number | undefined,
  y_pct: number | undefined
): boolean {
  const radius = question.toleranceRadiusPct ?? DEFAULT_HIT_RADIUS;
  return clickHitsFinding(question.targetMarker, x_pct ?? NaN, y_pct ?? NaN, radius);
}

export function gradeQuestion(question: Question, answer: LearnerAnswer | undefined): boolean {
  if (!answer || answer.questionId !== question.id) return false;
  switch (question.kind) {
    case "mcq":
      return gradeMcq(question, answer.selectedIndex);
    case "click_finding":
      return gradeClickFinding(question, answer.x_pct, answer.y_pct);
    case "report":
      // Report grading is async (Gemini) and arrives through gradeAttempt's
      // `reportGrades`; on its own a report is never "correct".
      return false;
    default:
      return false;
  }
}

export function gradeAttempt(
  questions: Question[],
  answers: LearnerAnswer[],
  reportGrades: Record<string, AttemptReportGrade> = {}
): { responses: AttemptResponse[]; score: number } {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const responses: AttemptResponse[] = questions.map((q) => {
    const answer = byId.get(q.id);
    if (q.kind === "report") {
      const grade = reportGrades[q.id];
      const overall = grade ? clampScore(grade.overall) : 0;
      return {
        questionId: q.id,
        text: cleanReportText(answer?.text),
        correct: Boolean(grade) && overall >= reportPassMark(q),
        credit: overall / 100,
        ...(grade ? { reportGrade: grade } : {}),
      };
    }
    const correct = gradeQuestion(q, answer);
    return {
      questionId: q.id,
      selectedIndex: answer?.selectedIndex,
      x_pct: answer?.x_pct,
      y_pct: answer?.y_pct,
      correct,
      credit: correct ? 1 : 0,
    };
  });
  return { responses, score: scoreResponses(responses, questions.length) };
}

/** Percent score from per-question credit (old attempts: correct → 1). */
export function scoreResponses(responses: AttemptResponse[], questionCount: number): number {
  if (questionCount === 0) return 0;
  const earned = responses.reduce((sum, r) => sum + responseCredit(r), 0);
  return Math.round((earned / questionCount) * 100);
}

export function responseCredit(response: AttemptResponse): number {
  if (typeof response.credit === "number" && Number.isFinite(response.credit)) {
    return Math.min(1, Math.max(0, response.credit));
  }
  return response.correct ? 1 : 0;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Strip answer keys before sending an assessment to the client. */
export function toPublicQuestions(questions: Question[]): Array<{
  id: string;
  kind: Question["kind"];
  prompt: string;
  options?: string[];
  caseId?: string;
  findingId?: string;
  passMark?: number;
}> {
  return questions.map((q) => {
    if (q.kind === "mcq") {
      return { id: q.id, kind: q.kind, prompt: q.prompt, options: q.options };
    }
    if (q.kind === "click_finding") {
      return {
        id: q.id,
        kind: q.kind,
        prompt: q.prompt,
        caseId: q.caseId,
        findingId: q.findingId,
      };
    }
    return {
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      caseId: q.caseId,
      passMark: reportPassMark(q),
    };
  });
}

// ----------------------------------------------------------------------------
// Review — what the learner sees about each question after submitting.
//
// Answer keys (the correct MCQ option and the click target) are revealed only
// on a passed attempt, so a failed learner cannot copy the key into a retake.
// A report always shows its rubric: an AI score is never shown bare.
// ----------------------------------------------------------------------------

export type QuestionReview =
  | {
      questionId: string;
      kind: "mcq";
      correct: boolean;
      credit: number;
      selectedIndex?: number;
      /** Only when keys are revealed. */
      correctIndex?: number;
      rationale?: string;
    }
  | {
      questionId: string;
      kind: "click_finding";
      correct: boolean;
      credit: number;
      x_pct?: number;
      y_pct?: number;
      /** Distance from the target in unit-square space; only when keys are revealed. */
      distance?: number;
      target?: Marker;
      toleranceRadiusPct?: number;
    }
  | {
      questionId: string;
      kind: "report";
      correct: boolean;
      credit: number;
      text: string;
      grade?: AttemptReportGrade;
    };

export type AttemptReview = {
  attemptId: string;
  /** Whether answer keys were included. */
  keysRevealed: boolean;
  questions: QuestionReview[];
};

export function reviewAttempt(questions: Question[], attempt: Attempt): AttemptReview {
  const keysRevealed = attempt.passed;
  const byId = new Map(attempt.responses.map((r) => [r.questionId, r]));
  const reviewed: QuestionReview[] = questions.map((q) => {
    const r = byId.get(q.id);
    const correct = Boolean(r?.correct);
    const credit = r ? responseCredit(r) : 0;
    if (q.kind === "mcq") {
      return {
        questionId: q.id,
        kind: "mcq",
        correct,
        credit,
        selectedIndex: r?.selectedIndex,
        ...(keysRevealed ? { correctIndex: q.correctIndex, rationale: q.rationale } : {}),
      };
    }
    if (q.kind === "click_finding") {
      const placed =
        typeof r?.x_pct === "number" && typeof r?.y_pct === "number"
          ? { x_pct: r.x_pct, y_pct: r.y_pct }
          : {};
      return {
        questionId: q.id,
        kind: "click_finding",
        correct,
        credit,
        ...placed,
        ...(keysRevealed
          ? {
              target: q.targetMarker,
              toleranceRadiusPct: q.toleranceRadiusPct ?? DEFAULT_HIT_RADIUS,
              ...("x_pct" in placed
                ? { distance: clickDistance(q.targetMarker, placed.x_pct!, placed.y_pct!) }
                : {}),
            }
          : {}),
      };
    }
    return {
      questionId: q.id,
      kind: "report",
      correct,
      credit,
      text: r?.text ?? "",
      ...(r?.reportGrade ? { grade: r.reportGrade } : {}),
    };
  });
  return { attemptId: attempt.id, keysRevealed, questions: reviewed };
}
