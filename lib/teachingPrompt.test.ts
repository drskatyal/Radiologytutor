import { test } from "node:test";
import assert from "node:assert/strict";
import {
  examFallbackStem,
  formatFindingsContext,
  teachingSystemPrompt,
} from "./teachingPrompt.ts";
import type { Finding } from "./types.ts";

const findings: Finding[] = [
  {
    id: "f1",
    label: "Caudate head",
    description: "Rounded contour at the caudate.",
    teachingPoints: ["Compare to the contralateral side"],
    state: " ",
    marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
    order: 0,
    sliceIndex: 3,
  },
];

test("formatFindingsContext includes marker, slice, and pearls — not pixels", () => {
  const ctx = formatFindingsContext(findings);
  assert.match(ctx, /id=f1/);
  assert.match(ctx, /label=Caudate head/);
  assert.match(ctx, /sliceIndex=3/);
  assert.match(ctx, /marker@\(0\.420,0\.480\)/);
  assert.match(ctx, /Compare to the contralateral/);
});

test("viva prompt forbids slideshow auto-advance and invented anatomy", () => {
  const p = teachingSystemPrompt({
    caseTitle: "BBMRI",
    modality: "MR",
    mode: "viva",
    findingsContext: formatFindingsContext(findings),
    currentFindingId: "f1",
  });
  assert.match(p, /Never invent anatomy/);
  assert.match(p, /Do not call next_in_tour in the same turn/);
  assert.match(p, /Ask ONE focused question/);
  assert.match(p, /ids and coordinates are for tools only/);
  assert.match(p, /CLICK the image to locate/);
  assert.match(p, /never invent a second series/);
});

test("formatFindingsContext includes a compare landing when authored", () => {
  const withCompare: Finding[] = [
    {
      ...findings[0],
      seriesInstanceUID: "ser-a",
      anchors: [
        {
          seriesInstanceUID: "ser-a",
          sliceIndex: 3,
          marker: { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
          viewportRole: "primary",
        },
        {
          seriesInstanceUID: "ser-b",
          sliceIndex: 1,
          marker: { x_pct: 0.5, y_pct: 0.55, shape: "circle" },
          viewportRole: "secondary",
        },
      ],
    },
  ];
  const ctx = formatFindingsContext(withCompare);
  assert.match(ctx, /compare\(series=ser-b,slice=1,marker@\(0\.500,0\.550\)\)/);
});

test("guided prompt still walks in order", () => {
  const p = teachingSystemPrompt({
    caseTitle: "BBMRI",
    modality: "MR",
    mode: "guided",
    findingsContext: "x",
  });
  assert.match(p, /GUIDED TOUR/);
  assert.match(p, /next_in_tour/);
  assert.match(p, /look-cue/);
});

test("examFallbackStem does not name the finding", () => {
  const stem = examFallbackStem(1);
  assert.doesNotMatch(stem, /caudate/i);
  assert.match(stem, /don't know/i);
});
