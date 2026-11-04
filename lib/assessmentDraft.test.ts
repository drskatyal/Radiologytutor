import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAssessmentDraft, type DraftCaseContext } from "./assessmentDraft.ts";

const cases: DraftCaseContext[] = [
  {
    caseId: "case-a",
    title: "Chest CT",
    findings: [
      { id: "f1", label: "Nodule", marker: { x_pct: 0.4, y_pct: 0.6, shape: "circle" } },
      { id: "f2", label: "Effusion", marker: null },
    ],
  },
  { caseId: "case-empty", title: "Empty", findings: [] },
];

function mint() {
  let n = 0;
  return () => `q_new_${++n}`;
}

const base = { title: "Post-test", passingScore: 70 };

test("valid MCQ, click and report questions come back clean", () => {
  const res = validateAssessmentDraft(
    {
      ...base,
      description: "  Check yourself.  ",
      questions: [
        { id: "q_keep", kind: "mcq", prompt: "Which?", options: ["A", "B"], correctIndex: 1, rationale: "B." },
        {
          kind: "click_finding",
          prompt: "Click the nodule",
          caseId: "case-a",
          findingId: "f1",
          toleranceRadiusPct: 0.5,
          // A posted target must be ignored.
          targetMarker: { x_pct: 0, y_pct: 0, shape: "circle" },
        },
        { kind: "report", prompt: "Report it", caseId: "case-a", findingIds: ["f1"], passMark: 65.4 },
      ],
    },
    cases,
    mint()
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const [m, c, r] = res.value.questions;
  assert.equal(res.value.description, "Check yourself.");
  assert.equal(m.id, "q_keep");
  assert.equal(c.id, "q_new_1");
  assert.equal(c.kind === "click_finding" && c.targetMarker.x_pct, 0.4);
  assert.equal(c.kind === "click_finding" && c.toleranceRadiusPct, 0.25);
  assert.deepEqual(r.kind === "report" && r.findingIds, ["f1"]);
  assert.equal(r.kind === "report" && r.passMark, 65);
});

test("every problem is reported in plain words", () => {
  const res = validateAssessmentDraft(
    {
      title: " ",
      passingScore: 0,
      questions: [
        { kind: "mcq", prompt: "", options: ["A", "a"], correctIndex: 3 },
        { kind: "click_finding", prompt: "x", caseId: "case-a", findingId: "f2" },
        { kind: "click_finding", prompt: "x", caseId: "other", findingId: "f1" },
        { kind: "report", prompt: "x", caseId: "case-empty" },
        { kind: "essay", prompt: "x" },
      ],
    },
    cases,
    mint()
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  const all = res.errors.join("\n");
  assert.match(all, /title/);
  assert.match(all, /Passing score/);
  assert.match(all, /Question 1: write the question/);
  assert.match(all, /Question 1: two options are the same/);
  assert.match(all, /Question 1: mark the correct option/);
  assert.match(all, /Question 2: "Effusion" has no marker yet/);
  assert.match(all, /Question 3: pick a case from this course/);
  assert.match(all, /Question 4: "Empty" has no findings/);
  assert.match(all, /Question 5: unknown question type/);
});

test("an empty post-test is refused", () => {
  const res = validateAssessmentDraft({ ...base, questions: [] }, cases, mint());
  assert.equal(res.ok, false);
});

test("duplicate or unsafe question ids are re-minted", () => {
  const q = { kind: "mcq", prompt: "?", options: ["A", "B"], correctIndex: 0 };
  const res = validateAssessmentDraft(
    { ...base, questions: [{ ...q, id: "dup" }, { ...q, id: "dup" }, { ...q, id: "../x" }] },
    cases,
    mint()
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(
    res.value.questions.map((x) => x.id),
    ["dup", "q_new_1", "q_new_2"]
  );
});
