import { test } from "node:test";
import assert from "node:assert/strict";
import { hapticTick, isSwipeUp, shouldDismissSheet } from "./sheetGesture";

test("sheet dismisses on a long drag or a quick flick down, not on a nudge", () => {
  assert.equal(shouldDismissSheet(120, 0), true);
  assert.equal(shouldDismissSheet(30, 900), true);
  assert.equal(shouldDismissSheet(30, 100), false);
  assert.equal(shouldDismissSheet(8, 2000), false, "a tap with jitter is not a flick");
  assert.equal(shouldDismissSheet(-200, -900), false, "dragging up never closes");
  assert.equal(shouldDismissSheet(Number.NaN, 0), false);
});

test("swipe up opens the drawer only when mostly vertical and far or fast enough", () => {
  assert.equal(isSwipeUp(0, -60, 400), true);
  assert.equal(isSwipeUp(5, -30, 40), true, "short fast flick");
  assert.equal(isSwipeUp(5, -30, 400), false, "short slow drag");
  assert.equal(isSwipeUp(80, -60, 100), false, "mostly horizontal");
  assert.equal(isSwipeUp(0, 60, 100), false, "downward");
  assert.equal(isSwipeUp(0, -60, 0), false);
});

test("haptics never throw without navigator.vibrate", () => {
  assert.doesNotThrow(() => hapticTick());
});
