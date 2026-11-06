import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanReportText,
  gradeAttempt,
  gradeClickFinding,
  gradeMcq,
  MAX_REPORT_CHARS,
  reportOverallForAttempt,
  reportPassMark,
  reviewAttempt,
  scoreResponses,
  toPublicQuestions,
} from "./assessmentGrade.ts";
import { buildQuestionRubric } from "./reportGrade.ts";
import type {
  Attempt,
  AttemptReportGrade,
  ClickFindingQuestion,
  Finding,
  McqQuestion,
  Question,
  ReportQuestion,
} from "./types.ts";

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

const report: ReportQuestion = {
  id: "q3",
  kind: "report",
  prompt: "Report the study",
  caseId: "demo-pacsbin",
  findingIds: ["f1"],
  passMark: 70,
};

function reportGrade(overall: number): AttemptReportGrade {
  return {
    overall,
    passMark: 70,
    gradedBy: "model",
    bands: [{ name: "Findings", score: overall, max: 100, comment: "ok" }],
    modelImpression: "",
    items: [{ findingId: "f1", label: "Nodule", verdict: "partial", gap: "Missing: size." }],
    rubric: [{ findingId: "f1", label: "Nodule", gold: "8 mm nodule.", mustMention: ["8 mm"] }],
  };
}

test("report questions earn partial credit and pass at their pass mark", () => {
  const { responses, score } = gradeAttempt(
    [mcq, click, report],
    [
      { questionId: "q1", selectedIndex: 1 },
      { questionId: "q2", x_pct: 0.25, y_pct: 0.5 },
      { questionId: "q3", text: "  Findings: nodule.  " },
    ],
    { q3: reportGrade(55) }
  );
  assert.equal(responses[2].correct, false);
  assert.equal(responses[2].credit, 0.55);
  assert.equal(responses[2].text, "Findings: nodule.");
  assert.equal(responses[2].reportGrade?.overall, 55);
  assert.equal(score, Math.round((2.55 / 3) * 100));

  const passing = gradeAttempt([report], [{ questionId: "q3", text: "x" }], {
    q3: reportGrade(70),
  });
  assert.equal(passing.responses[0].correct, true);
  assert.equal(passing.score, 70);
});

test("an ungraded report earns nothing and is never correct", () => {
  const { responses, score } = gradeAttempt([report], [{ questionId: "q3", text: "x" }]);
  assert.equal(responses[0].correct, false);
  assert.equal(responses[0].credit, 0);
  assert.equal(score, 0);
});

test("scoreResponses reads attempts stored before partial credit", () => {
  assert.equal(
    scoreResponses(
      [
        { questionId: "a", correct: true },
        { questionId: "b", correct: false },
      ],
      2
    ),
    50
  );
});

test("report pass mark defaults to 60 and is clamped", () => {
  assert.equal(reportPassMark({ ...report, passMark: undefined }), 60);
  assert.equal(reportPassMark({ ...report, passMark: 140 }), 100);
  assert.equal(reportPassMark({ ...report, passMark: -3 }), 0);
});

test("cleanReportText trims and caps the report", () => {
  assert.equal(cleanReportText(undefined), "");
  assert.equal(cleanReportText(42), "");
  assert.equal(cleanReportText("x".repeat(MAX_REPORT_CHARS + 50)).length, MAX_REPORT_CHARS);
});

test("toPublicQuestions hides a report's finding ids but shows its pass mark", () => {
  const [pub] = toPublicQuestions([report]);
  assert.deepEqual(pub, {
    id: "q3",
    kind: "report",
    prompt: "Report the study",
    caseId: "demo-pacsbin",
    passMark: 70,
  });
});

function attemptFor(passed: boolean): Attempt {
  const { responses, score } = gradeAttempt(
    [mcq, click, report],
    [
      { questionId: "q1", selectedIndex: 0 },
      { questionId: "q2", x_pct: 0.3, y_pct: 0.5 },
      { questionId: "q3", text: "Findings: nodule." },
    ],
    { q3: reportGrade(80) }
  );
  return {
    id: "att_1",
    userId: "u",
    orgId: "org_demo",
    assessmentId: "assess",
    courseId: "course",
    responses,
    score,
    passed,
    startedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("reviewAttempt withholds answer keys on a failed attempt", () => {
  const review = reviewAttempt([mcq, click, report], attemptFor(false));
  assert.equal(review.keysRevealed, false);
  const [m, c, r] = review.questions;
  assert.equal(m.kind, "mcq");
  assert.equal(m.kind === "mcq" && m.correctIndex, undefined);
  assert.equal(m.kind === "mcq" && m.rationale, undefined);
  assert.equal(m.kind === "mcq" && m.selectedIndex, 0);
  assert.equal(c.kind === "click_finding" && c.target, undefined);
  assert.equal(c.kind === "click_finding" && c.distance, undefined);
  assert.equal(c.kind === "click_finding" && c.x_pct, 0.3);
  // The rubric is always shown with a report score.
  assert.equal(r.kind === "report" && r.grade?.rubric.length, 1);
  assert.equal(r.correct, true);
  assert.equal(r.credit, 0.8);
});

test("reviewAttempt reveals keys, rationale and click distance on a pass", () => {
  const review = reviewAttempt([mcq, click, report], attemptFor(true));
  assert.equal(review.keysRevealed, true);
  const [m, c] = review.questions;
  assert.equal(m.kind === "mcq" && m.correctIndex, 1);
  assert.equal(m.kind === "mcq" && m.rationale, "b is right");
  assert.deepEqual(c.kind === "click_finding" && c.target, click.targetMarker);
  assert.equal(c.kind === "click_finding" && c.toleranceRadiusPct, 0.08);
  assert.ok(c.kind === "click_finding" && Math.abs((c.distance ?? 0) - 0.05) < 1e-9);
});

const findings = [
  { id: "f2", order: 2, label: "Effusion", description: "Small effusion.", teachingPoints: [] },
  { id: "f1", order: 1, label: "Nodule", description: "8 mm nodule.", teachingPoints: [] },
] as unknown as Finding[];

test("buildQuestionRubric limits to named findings and falls back to the case", () => {
  assert.deepEqual(
    buildQuestionRubric(findings, ["f2"]).map((r) => r.findingId),
    ["f2"]
  );
  assert.deepEqual(
    buildQuestionRubric(findings, ["nope"]).map((r) => r.findingId),
    ["f1", "f2"]
  );
  assert.deepEqual(
    buildQuestionRubric(findings).map((r) => r.findingId),
    ["f1", "f2"]
  );
});

test("a fallback (findings-only) report grade is scaled to 100", () => {
  const bands = [
    { name: "Findings", score: 40, max: 50 },
    { name: "Impression", score: 0, max: 30 },
    { name: "Language", score: 0, max: 20 },
  ];
  assert.equal(reportOverallForAttempt("local", { overall: 40, bands }), 80);
  assert.equal(reportOverallForAttempt("model", { overall: 63, bands }), 63);
  assert.equal(reportOverallForAttempt("local", { overall: 0, bands: [] }), 0);
});
