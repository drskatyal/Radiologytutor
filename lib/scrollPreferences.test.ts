import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SCROLL_PREFERENCES,
  parseScrollPreferences,
  serializeScrollPreferences,
} from "@flowrad/viewer-core/scrollSensitivity";

test("scroll preferences: round-trip through storage", () => {
  const p = { slicesPerNotch: 3, dragPixelsPerSlice: 12, acceleration: true };
  assert.deepEqual(parseScrollPreferences(serializeScrollPreferences(p)), p);
  const auto = { slicesPerNotch: 1, dragPixelsPerSlice: null, acceleration: false };
  assert.deepEqual(parseScrollPreferences(serializeScrollPreferences(auto)), auto);
});

test("scroll preferences: nothing stored, or garbage, is the defaults", () => {
  assert.deepEqual(parseScrollPreferences(null), DEFAULT_SCROLL_PREFERENCES);
  assert.deepEqual(parseScrollPreferences(""), DEFAULT_SCROLL_PREFERENCES);
  assert.deepEqual(parseScrollPreferences("{not json"), DEFAULT_SCROLL_PREFERENCES);
  assert.deepEqual(parseScrollPreferences("[1,2]"), DEFAULT_SCROLL_PREFERENCES);
});

test("scroll preferences: clamped field by field, as the live setter clamps", () => {
  assert.deepEqual(parseScrollPreferences('{"slicesPerNotch":99,"dragPixelsPerSlice":500,"acceleration":"yes"}'), {
    slicesPerNotch: 10,
    dragPixelsPerSlice: 60,
    acceleration: false,
  });
  assert.deepEqual(parseScrollPreferences('{"slicesPerNotch":0.2,"dragPixelsPerSlice":0}'), {
    slicesPerNotch: 1,
    dragPixelsPerSlice: null,
    acceleration: false,
  });
  assert.equal(parseScrollPreferences('{"slicesPerNotch":"x"}').slicesPerNotch, 1);
});
