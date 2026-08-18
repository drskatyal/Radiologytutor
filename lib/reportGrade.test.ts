import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReportRubric,
  normalizeReportGrade,
} from "./reportGrade.ts";
import type { Finding } from "./types.ts";

const findings: Finding[] = [
  {
    id: "f1",
    label: "Caudate head",
    description: "Rounded contour.",
    teachingPoints: ["Compare contralateral"],
    state: " ",
    marker: { x_pct: 0.4, y_pct: 0.4, shape: "circle" },
    order: 0,
  },
];

test("buildReportRubric lists authored labels and pearls", () => {
  const rubric = buildReportRubric(findings);
  assert.equal(rubric[0].label, "Caudate head");
  assert.deepEqual(rubric[0].mustMention, [
    "Rounded contour.",
    "Compare contralateral",
  ]);
});

test("normalizeReportGrade always attaches the rubric and clamps scores", () => {
  const grade = normalizeReportGrade(
    {
      overall: 140,
      bands: [{ name: "Findings", score: 80, max: 50, comment: "Good." }],
      missed: ["Caudate head", ""],
    },
    buildReportRubric(findings)
  );
  assert.equal(grade.overall, 100);
  assert.equal(grade.bands[0].score, 50);
  assert.equal(grade.bands[0].max, 50);
  assert.equal(grade.rubric[0].label, "Caudate head");
  assert.deepEqual(grade.missed, ["Caudate head"]);
});

test("normalizeReportGrade fills empty Gemini output", () => {
  const grade = normalizeReportGrade({}, buildReportRubric(findings));
  assert.equal(grade.overall, 0);
  assert.equal(grade.bands.length, 3);
  assert.equal(grade.rubric.length, 1);
});
