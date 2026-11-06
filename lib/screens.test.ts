import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMultipleScreens } from "./screens.ts";

test("multi-monitor UI only when the browser reports an extended desktop", () => {
  assert.equal(hasMultipleScreens({ isExtended: true }), true);
  assert.equal(hasMultipleScreens({ isExtended: false }), false);
  assert.equal(hasMultipleScreens({}), false, "unsupported API means one screen");
  assert.equal(hasMultipleScreens(undefined), false);
});
