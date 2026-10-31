import { strict as assert } from "node:assert";
import { test } from "node:test";
import { previewBlocksPress } from "./previewLock";

test("on a preview, W/L and measurement drags are held; navigation is not", () => {
  const left = { type: "mousedown", button: 0 };
  assert.equal(previewBlocksPress(true, "WindowLevel", left), true);
  assert.equal(previewBlocksPress(true, "Length", left), true);
  assert.equal(previewBlocksPress(true, "Probe", { type: "touchstart", touchCount: 1 }), true);
  assert.equal(previewBlocksPress(true, "StackScroll", left), false);
  assert.equal(previewBlocksPress(true, "Pan", left), false);
  assert.equal(previewBlocksPress(true, "WindowLevel", { type: "mousedown", button: 2 }), false, "right-drag zoom");
  assert.equal(previewBlocksPress(true, "WindowLevel", { type: "mousedown", button: 1 }), false, "middle-drag pan");
  assert.equal(previewBlocksPress(true, "WindowLevel", { type: "touchstart", touchCount: 2 }), false, "pinch");
});

test("full quality unlocks everything", () => {
  assert.equal(previewBlocksPress(false, "WindowLevel", { type: "mousedown", button: 0 }), false);
  assert.equal(previewBlocksPress(false, "Length", { type: "touchstart", touchCount: 1 }), false);
});
