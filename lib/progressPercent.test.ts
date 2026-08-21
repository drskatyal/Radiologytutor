import { test } from "node:test";
import assert from "node:assert/strict";

/** Mirrors lib/cases progressPercent — keep in sync. */
function progressPercent(completedCaseIds: string[], totalCases: number): number {
  if (totalCases <= 0) return 0;
  return Math.min(100, Math.round((completedCaseIds.length / totalCases) * 100));
}

test("progressPercent is 0 with no cases or no completions", () => {
  assert.equal(progressPercent([], 0), 0);
  assert.equal(progressPercent([], 4), 0);
});

test("progressPercent rounds completed / total to 0–100", () => {
  assert.equal(progressPercent(["a"], 4), 25);
  assert.equal(progressPercent(["a", "b"], 3), 67);
  assert.equal(progressPercent(["a", "b", "c"], 3), 100);
});

test("progressPercent never exceeds 100 even if over-completed", () => {
  assert.equal(progressPercent(["a", "b", "c", "d"], 2), 100);
});
