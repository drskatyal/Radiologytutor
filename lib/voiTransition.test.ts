import { test } from "node:test";
import assert from "node:assert/strict";
import { voiTransitionMs, VOI_SMOOTH_MAX_DELTA } from "./voiTransition.ts";

test("tiny VOI nudge is a short scroll, not a snap", () => {
  const ms = voiTransitionMs(400, 40, 420, 45);
  assert.ok(ms >= 280 && ms < 900);
});

test("near-threshold delta approaches full smooth duration", () => {
  const ms = voiTransitionMs(400, 40, 400 + VOI_SMOOTH_MAX_DELTA, 40);
  assert.ok(ms >= 800 && ms <= 900);
});

test("bone → lung snaps (direct jump)", () => {
  // Bone ~2500/480, lung ~1500/-600 — far beyond 150
  assert.equal(voiTransitionMs(2500, 480, 1500, -600), 0);
});

test("identical VOI needs no motion", () => {
  assert.equal(voiTransitionMs(400, 40, 400, 40), 0);
});
