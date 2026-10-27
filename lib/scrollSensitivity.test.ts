import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DRAG_DISTANCE_MULTIPLIER,
  DRAG_MIN_PIXELS_PER_SLICE,
  PREVIOUS_DRAG_MIN_PIXELS,
  PREVIOUS_WHEEL_SLICES_PER_EVENT,
  WHEEL_BURST_MS,
  WHEEL_PIXELS_PER_SLICE,
  createWheelScrollState,
  scaleDragPixelsPerSlice,
  takeWheelSlices,
} from "./scrollSensitivity.ts";

test("a mouse notch of about 100px is one slice", () => {
  const state = createWheelScrollState();
  assert.equal(PREVIOUS_WHEEL_SLICES_PER_EVENT, 1);
  assert.equal(takeWheelSlices(state, 100, 0), 1);
  assert.equal(state.y, 0);
  assert.equal(takeWheelSlices(state, -120, WHEEL_BURST_MS + 1), -1);
});

test("several events from one notch count as one slice", () => {
  const state = createWheelScrollState();
  assert.equal(takeWheelSlices(state, 100, 0), 1);
  assert.equal(takeWheelSlices(state, 100, 16), 0);
  assert.equal(takeWheelSlices(state, 100, 32), 0);
  assert.equal(takeWheelSlices(state, 100, WHEEL_BURST_MS + 5), 1);
});

test("trackpad ticks accumulate instead of jumping a slice each", () => {
  const state = createWheelScrollState();
  let slices = 0;
  // One tick every 16ms. 100px must land before a second slice is allowed.
  for (let i = 0; i < 10; i += 1) slices += takeWheelSlices(state, 10, i * 16);
  assert.equal(slices, 1);
  assert.ok(Math.abs(state.y) < WHEEL_PIXELS_PER_SLICE);
});

test("one wheel burst cannot fling the stack", () => {
  const state = createWheelScrollState();
  assert.equal(takeWheelSlices(state, 4000, 0), 1);
  assert.equal(takeWheelSlices(state, 4000, 10), 0);
  assert.ok(Math.abs(state.y) < WHEEL_PIXELS_PER_SLICE);
});

test("drag asks for three times the distance, and never under 8px", () => {
  assert.equal(DRAG_DISTANCE_MULTIPLIER, 3);
  assert.equal(PREVIOUS_DRAG_MIN_PIXELS, 2);
  assert.equal(scaleDragPixelsPerSlice(2), DRAG_MIN_PIXELS_PER_SLICE);
  assert.equal(scaleDragPixelsPerSlice(12), 36);
  assert.equal(scaleDragPixelsPerSlice(Number.NaN), DRAG_MIN_PIXELS_PER_SLICE);
});
