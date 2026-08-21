import { test } from "node:test";
import assert from "node:assert/strict";
import {
  casePublishReadiness,
  findingGaps,
  isExamReadyFinding,
  isTeachableFinding,
} from "./findingQuality.ts";
import type { Finding } from "./types.ts";

function finding(partial: Partial<Finding>): Finding {
  return {
    id: partial.id ?? "f1",
    label: partial.label ?? "",
    description: partial.description ?? "",
    teachingPoints: partial.teachingPoints ?? [],
    state: " ",
    marker: partial.marker ?? { x_pct: 0.42, y_pct: 0.48, shape: "circle" },
    order: partial.order ?? 0,
    sliceIndex: partial.sliceIndex,
    sopInstanceUID: partial.sopInstanceUID,
  };
}

test("findingGaps flags missing label, teaching points, and slice", () => {
  const gaps = findingGaps(
    finding({
      label: "  ",
      teachingPoints: [],
      marker: { x_pct: 0.2, y_pct: 0.3, shape: "circle" },
    })
  );
  assert.deepEqual(gaps, ["label", "teaching", "slice"]);
});

test("isTeachableFinding requires label and a placed marker", () => {
  assert.equal(isTeachableFinding(finding({ label: "Caudate head" })), true);
  assert.equal(isTeachableFinding(finding({ label: "" })), false);
  assert.equal(
    isTeachableFinding(
      finding({
        label: "Caudate",
        marker: { x_pct: Number.NaN, y_pct: 0.5, shape: "circle" },
      })
    ),
    false
  );
});

test("isExamReadyFinding requires a teaching point", () => {
  assert.equal(
    isExamReadyFinding(finding({ label: "Caudate", teachingPoints: [] })),
    false
  );
  assert.equal(
    isExamReadyFinding(
      finding({ label: "Caudate", teachingPoints: ["Look for mass effect"] })
    ),
    true
  );
});

test("casePublishReadiness blocks empty and unlabeled cases", () => {
  assert.equal(casePublishReadiness([]).ready, false);
  assert.equal(casePublishReadiness([finding({ label: "" })]).ready, false);
  const ok = casePublishReadiness([
    finding({
      label: "Caudate head",
      teachingPoints: ["Compare to contralateral"],
      sliceIndex: 3,
    }),
  ]);
  assert.equal(ok.ready, true);
  assert.equal(ok.teachable, 1);
  assert.equal(ok.examReady, 1);
});
