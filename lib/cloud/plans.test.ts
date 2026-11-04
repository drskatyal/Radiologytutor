import { test } from "node:test";
import assert from "node:assert/strict";
import { PLANS, checkStudyQuota, formatPlaceholderPrice, planById } from "./plans.ts";

test("plans are ordered by study limit: free 20, pro 500, super 2000", () => {
  assert.deepEqual(
    PLANS.map((p) => [p.id, p.studyLimit]),
    [
      ["free", 20],
      ["pro", 500],
      ["super", 2000],
    ]
  );
});

test("unknown plan falls back to free", () => {
  assert.equal(planById("enterprise").id, "free");
  assert.equal(planById(undefined).id, "free");
});

test("quota allows up to the limit and refuses past it", () => {
  assert.equal(checkStudyQuota("free", 19).ok, true);
  assert.equal(checkStudyQuota("free", 20).ok, false);
  assert.equal(checkStudyQuota("pro", 20).remaining, 480);
  assert.equal(checkStudyQuota("free", 25).remaining, 0);
  assert.equal(checkStudyQuota("super", 1999, 2).ok, false);
});

test("placeholder price renders $0 for free", () => {
  assert.equal(formatPlaceholderPrice(planById("free")), "$0");
});
