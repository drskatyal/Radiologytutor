import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPerformancePlan,
  isLiveAction,
  normalizeTutorActions,
  splitSentences,
} from "./performancePlan.ts";

test("splitSentences breaks on period", () => {
  assert.deepEqual(
    splitSentences("Look here. That's the caudate — compare the other side."),
    ["Look here.", "That's the caudate — compare the other side."]
  );
});

test("splitSentences keeps a single sentence intact", () => {
  assert.deepEqual(splitSentences("What do you see on this slice?"), [
    "What do you see on this slice?",
  ]);
});

test("buildPerformancePlan puts the first action on the first beat", () => {
  const plan = buildPerformancePlan("Look here. Pearl follows.", [
    { type: "show_finding", findingId: "f1" },
  ]);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].text, "Look here.");
  assert.equal(plan[0].actions[0]?.type, "show_finding");
  assert.equal(plan[1].actions.length, 0);
});

test("buildPerformancePlan spreads extra actions onto later beats", () => {
  const plan = buildPerformancePlan("Look. And here.", [
    { type: "show_finding", findingId: "f1" },
    { type: "point_to", findingId: "f1" },
  ]);
  assert.equal(plan[0].actions[0]?.type, "show_finding");
  assert.equal(plan[1].actions[0]?.type, "point_to");
});

test("buildPerformancePlan piles leftover actions on the last beat", () => {
  const plan = buildPerformancePlan("One line.", [
    { type: "set_window", windowWidth: 400, windowCenter: 40 },
    { type: "show_finding", findingId: "f1" },
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].actions.length, 2);
});

test("normalizeTutorActions prefers the actions array", () => {
  const out = normalizeTutorActions({
    action: { type: "none" },
    actions: [{ type: "show_finding", findingId: "f1" }, { type: "none" }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "show_finding");
});

test("isLiveAction rejects none", () => {
  assert.equal(isLiveAction({ type: "none" }), false);
  assert.equal(isLiveAction({ type: "point_to" }), true);
});
