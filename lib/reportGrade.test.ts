import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReportRubric,
  compareReportToGold,
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
  assert.equal(grade.items.length, 1);
  assert.equal(grade.items[0].verdict, "missed");
  assert.match(grade.items[0].gap, /Rounded contour/);
});

test("buildReportRubric prefers authored gold over the teaching script", () => {
  const rubric = buildReportRubric([
    {
      ...findings[0],
      reportGold: "Rounded contour of the caudate head.",
      reportMustMention: ["caudate", "rounded contour"],
    },
  ]);
  assert.equal(rubric[0].gold, "Rounded contour of the caudate head.");
  assert.deepEqual(rubric[0].mustMention, ["caudate", "rounded contour"]);
});

test("compareReportToGold marks hit, partial, and missed against phrases", () => {
  const rubric = buildReportRubric([
    {
      ...findings[0],
      reportGold: "Rounded contour of the caudate head.",
      reportMustMention: ["caudate", "rounded contour"],
    },
    {
      ...findings[0],
      id: "f2",
      order: 1,
      label: "Contralateral",
      reportGold: "Compare the contralateral caudate.",
      reportMustMention: ["contralateral"],
    },
  ]);
  const graded = compareReportToGold(
    "Rounded contour of the caudate. No other comment.",
    rubric
  );
  assert.equal(graded[0].verdict, "hit");
  assert.equal(graded[0].gap, "");
  assert.equal(graded[1].verdict, "missed");
  assert.match(graded[1].gap, /contralateral caudate/i);

  const partial = compareReportToGold("The caudate is visible.", rubric);
  assert.equal(partial[0].verdict, "partial");
  assert.match(partial[0].gap, /rounded contour/i);
  assert.doesNotMatch(partial[0].gap, /spiculated|upper lobe/i);
});

test("solid is not credited inside subsolid", () => {
  const rubric = buildReportRubric([
    {
      ...findings[0],
      reportGold: "Density is solid or subsolid.",
      reportMustMention: ["solid", "subsolid"],
    },
  ]);
  const graded = compareReportToGold("Density is subsolid.", rubric);
  assert.equal(graded[0].verdict, "partial");
  assert.match(graded[0].gap, /Missing: solid/);
});

test("normalizeReportGrade keeps rubric lines and drops invented anatomy", () => {
  const rubric = buildReportRubric([
    {
      ...findings[0],
      label: "Lung windows",
      reportGold: "Lung windows at width 1500 and level -600.",
      reportMustMention: ["1500", "-600"],
    },
  ]);
  const grade = normalizeReportGrade(
    {
      overall: 90,
      missed: ["Lung windows", "4 cm right upper lobe mass"],
      modelImpression: "Spiculated 4 cm mass in the right upper lobe.",
      bands: [
        {
          name: "Findings",
          score: 40,
          max: 50,
          comment: "Missed the spiculated right upper lobe mass.",
        },
      ],
      items: [
        {
          findingId: "invented",
          label: "Right upper lobe mass",
          verdict: "missed",
          gap: "4 cm spiculated mass.",
        },
        {
          findingId: "f1",
          label: "Lung windows",
          verdict: "wrong",
          gap: "Report says soft-tissue windows only. Gold requires lung windows at 1500 and -600.",
        },
      ],
    },
    rubric,
    "Reviewed on soft-tissue windows only."
  );
  assert.equal(grade.items.length, 1);
  assert.equal(grade.items[0].findingId, "f1");
  assert.equal(grade.items[0].label, "Lung windows");
  assert.equal(grade.items[0].verdict, "wrong");
  assert.match(grade.items[0].gap, /1500/);
  assert.doesNotMatch(grade.items[0].gap, /spiculated|upper lobe|4 cm/);
  assert.deepEqual(grade.missed, ["Lung windows"]);
  assert.match(grade.modelImpression, /1500/);
  assert.doesNotMatch(grade.modelImpression, /spiculated|upper lobe/);
  assert.doesNotMatch(grade.bands[0].comment, /spiculated|upper lobe/);
});

test("a model hit cannot excuse a report that omits the gold line", () => {
  const rubric = buildReportRubric([
    {
      ...findings[0],
      reportGold: "Rounded contour of the caudate head.",
      reportMustMention: ["caudate", "rounded contour"],
    },
  ]);
  const grade = normalizeReportGrade(
    {
      overall: 95,
      items: [{ findingId: "f1", label: "Caudate head", verdict: "hit", gap: "" }],
    },
    rubric,
    "Normal study."
  );
  assert.equal(grade.items[0].verdict, "missed");
  assert.match(grade.items[0].gap, /Rounded contour of the caudate head/);
});

test("LIDC seed rubric is the authored gold, not a new nodule", () => {
  const seed = JSON.parse(
    readFileSync(new URL("../seed/case-lidc-nodule-search.json", import.meta.url), "utf8")
  ) as { findings: Finding[] };
  const rubric = buildReportRubric(seed.findings);
  assert.equal(rubric.length, 3);
  assert.match(rubric[0].gold, /1500/);
  assert.match(rubric[0].gold, /-600/);
  assert.match(rubric[1].gold, /vessel/i);
  assert.match(rubric[1].gold, /subsolid/i);
  assert.match(rubric[2].gold, /calcified granulomas/i);
  const blob = rubric.map((item) => `${item.gold} ${item.mustMention.join(" ")}`).join("\n");
  assert.doesNotMatch(blob, /spiculated|right upper lobe|4 cm|Fleischner/i);
  const covered = compareReportToGold(
    rubric.map((item) => item.gold).join("\n"),
    rubric
  );
  assert.deepEqual(
    covered.map((item) => item.verdict),
    ["hit", "hit", "hit"]
  );
});
