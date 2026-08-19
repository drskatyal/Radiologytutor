import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeAttempt,
  gradeClickFinding,
  gradeMcq,
  toPublicQuestions,
} from "./assessmentGrade.ts";
import type { ClickFindingQuestion, McqQuestion, Question } from "./types.ts";

const mcq: McqQuestion = {
  id: "q1",
  kind: "mcq",
  prompt: "Pick one",
  options: ["a", "b", "c"],
  correctIndex: 1,
  rationale: "b is right",
};

const click: ClickFindingQuestion = {
  id: "q2",
  kind: "click_finding",
  prompt: "Click it",
  caseId: "demo-pacsbin",
  findingId: "f1",
  targetMarker: { x_pct: 0.25, y_pct: 0.5, shape: "circle" },
  toleranceRadiusPct: 0.08,
};

test("gradeMcq accepts the correct index only", () => {
  assert.equal(gradeMcq(mcq, 1), true);
  assert.equal(gradeMcq(mcq, 0), false);
  assert.equal(gradeMcq(mcq, undefined), false);
});

test("gradeClickFinding reuses marker hit radius", () => {
  assert.equal(gradeClickFinding(click, 0.26, 0.51), true);
  assert.equal(gradeClickFinding(click, 0.9, 0.9), false);
  assert.equal(gradeClickFinding(click, undefined, undefined), false);
});

test("gradeAttempt scores percent and per-question correctness", () => {
  const questions: Question[] = [mcq, click];
  const { responses, score } = gradeAttempt(questions, [
    { questionId: "q1", selectedIndex: 1 },
    { questionId: "q2", x_pct: 0.9, y_pct: 0.9 },
  ]);
  assert.equal(score, 50);
  assert.equal(responses[0].correct, true);
  assert.equal(responses[1].correct, false);
});

test("gradeAttempt is 100 when all answers are correct", () => {
  const { score } = gradeAttempt([mcq, click], [
    { questionId: "q1", selectedIndex: 1 },
    { questionId: "q2", x_pct: 0.25, y_pct: 0.5 },
  ]);
  assert.equal(score, 100);
});

test("toPublicQuestions strips answer keys and target markers", () => {
  const pub = toPublicQuestions([mcq, click]);
  assert.deepEqual(pub[0], {
    id: "q1",
    kind: "mcq",
    prompt: "Pick one",
    options: ["a", "b", "c"],
  });
  assert.equal("correctIndex" in pub[0], false);
  assert.deepEqual(pub[1], {
    id: "q2",
    kind: "click_finding",
    prompt: "Click it",
    caseId: "demo-pacsbin",
    findingId: "f1",
  });
  assert.equal("targetMarker" in pub[1], false);
});
