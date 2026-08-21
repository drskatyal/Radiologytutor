// Deterministic grading for MCQ + click-the-finding assessment questions.
// Report questions reuse lib/reportGrade.ts (Gemini) and are out of scope here.

import { clickHitsFinding, DEFAULT_HIT_RADIUS } from "./clickFinding";
import type {
  AttemptResponse,
  ClickFindingQuestion,
  McqQuestion,
  Question,
} from "./types";

export type LearnerAnswer = {
  questionId: string;
  selectedIndex?: number;
  x_pct?: number;
  y_pct?: number;
  text?: string;
};

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
      // Report grading is async (Gemini); treat unanswered as incorrect here.
      return false;
    default:
      return false;
  }
}

export function gradeAttempt(
  questions: Question[],
  answers: LearnerAnswer[]
): { responses: AttemptResponse[]; score: number } {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const responses: AttemptResponse[] = questions.map((q) => {
    const answer = byId.get(q.id);
    const correct = gradeQuestion(q, answer);
    return {
      questionId: q.id,
      selectedIndex: answer?.selectedIndex,
      x_pct: answer?.x_pct,
      y_pct: answer?.y_pct,
      text: answer?.text,
      correct,
    };
  });
  const scored = responses.filter((r) => r.correct).length;
  const score =
    questions.length === 0 ? 0 : Math.round((scored / questions.length) * 100);
  return { responses, score };
}

/** Strip answer keys before sending an assessment to the client. */
export function toPublicQuestions(questions: Question[]): Array<{
  id: string;
  kind: Question["kind"];
  prompt: string;
  options?: string[];
  caseId?: string;
  findingId?: string;
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
    return { id: q.id, kind: q.kind, prompt: q.prompt, caseId: q.caseId };
  });
}
