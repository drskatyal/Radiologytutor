import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CINE_FPS_OPTIONS,
  DEFAULT_CINE_FPS,
  MAX_CINE_FPS,
  MIN_CINE_FPS,
  advanceCine,
  cineAvailable,
  cineFrameMs,
  clampCineFps,
  createCineState,
  initialCineFps,
} from "./cinePlayer";

test("the frame rate is clamped to something a decoder can serve", () => {
  assert.equal(clampCineFps(0), MIN_CINE_FPS);
  assert.equal(clampCineFps(-20), MIN_CINE_FPS);
  assert.equal(clampCineFps(1_000), MAX_CINE_FPS);
  assert.equal(clampCineFps(Number.NaN), DEFAULT_CINE_FPS);
  assert.equal(clampCineFps(15.4), 15);
});

test("every offered frame rate survives clamping", () => {
  for (const fps of CINE_FPS_OPTIONS) assert.equal(clampCineFps(fps), fps);
});

test("the frame interval matches the rate", () => {
  assert.equal(cineFrameMs(10), 100);
  assert.equal(cineFrameMs(20), 50);
  assert.ok(cineFrameMs(Number.NaN) > 0);
});

test("loop runs off the end and restarts at the other", () => {
  const state = createCineState(1);
  assert.deepEqual(advanceCine(state, 8, 10, "loop"), { index: 9, direction: 1 });
  assert.deepEqual(advanceCine(state, 9, 10, "loop"), { index: 0, direction: 1 });
  const back = createCineState(-1);
  assert.deepEqual(advanceCine(back, 0, 10, "loop"), { index: 9, direction: -1 });
});

test("bounce reverses at the ends and stays inside the stack", () => {
  const state = createCineState(1);
  assert.deepEqual(advanceCine(state, 8, 10, "bounce"), { index: 9, direction: 1 });
  assert.deepEqual(advanceCine(state, 9, 10, "bounce"), { index: 8, direction: -1 });
  assert.equal(state.direction, -1, "the state carries the reversal");
  assert.deepEqual(advanceCine(state, 1, 10, "bounce"), { index: 0, direction: -1 });
  assert.deepEqual(advanceCine(state, 0, 10, "bounce"), { index: 1, direction: 1 });
});

test("a full bounce sweep never leaves the stack", () => {
  const state = createCineState(1);
  let index = 0;
  for (let tick = 0; tick < 500; tick += 1) {
    index = advanceCine(state, index, 7, "bounce").index;
    assert.ok(index >= 0 && index <= 6, `tick ${tick} landed on ${index}`);
  }
});

test("a loop visits every frame", () => {
  const state = createCineState(1);
  const seen = new Set<number>();
  let index = 0;
  for (let tick = 0; tick < 40; tick += 1) {
    index = advanceCine(state, index, 10, "loop").index;
    seen.add(index);
  }
  assert.equal(seen.size, 10);
});

test("a single image has nowhere to go", () => {
  const state = createCineState(1);
  assert.deepEqual(advanceCine(state, 0, 1, "loop"), { index: 0, direction: 1 });
  assert.deepEqual(advanceCine(state, 0, 0, "bounce"), { index: 0, direction: 1 });
});

test("an out-of-range index is clamped before stepping", () => {
  const state = createCineState(1);
  assert.equal(advanceCine(state, -50, 10, "loop").index, 1);
  assert.equal(advanceCine(createCineState(1), 500, 10, "loop").index, 0);
});

test("cine is offered only where a loop means something", () => {
  assert.equal(cineAvailable(1), false);
  assert.equal(cineAvailable(2), false);
  assert.equal(cineAvailable(3), true);
  assert.equal(cineAvailable(240), true);
  assert.equal(cineAvailable(Number.NaN), false);
});

test("a DICOM frame rate wins over our default", () => {
  assert.equal(initialCineFps(30), 30);
  assert.equal(initialCineFps(8), 8);
  assert.equal(initialCineFps(null), DEFAULT_CINE_FPS);
  assert.equal(initialCineFps(undefined), DEFAULT_CINE_FPS);
  assert.equal(initialCineFps(0), DEFAULT_CINE_FPS);
  assert.equal(initialCineFps(500), MAX_CINE_FPS);
});
