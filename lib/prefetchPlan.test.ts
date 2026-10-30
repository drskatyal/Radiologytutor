import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TRAVEL_AHEAD,
  TRAVEL_BEHIND,
  createScrollDirectionState,
  directionalPrefetchIndexes,
  prefetchRadiusFor,
  trackScrollDirection,
} from "./prefetchPlan";

test("a short series is warmed whole; a long one keeps a window", () => {
  assert.equal(prefetchRadiusFor(30), 30, "a 30-slice MR fits in cache");
  assert.equal(prefetchRadiusFor(64), 64);
  assert.equal(prefetchRadiusFor(65), 16);
  assert.equal(prefetchRadiusFor(240), 16, "routine chest CT");
  assert.equal(prefetchRadiusFor(1200), 12, "CTA stays a window");
});

test("prefetchRadiusFor degrades safely on a non-series", () => {
  assert.equal(prefetchRadiusFor(0), 0);
  assert.equal(prefetchRadiusFor(1), 0);
  assert.equal(prefetchRadiusFor(Number.NaN), 0);
});

test("the first slice sample has no direction yet", () => {
  const state = createScrollDirectionState();
  assert.equal(trackScrollDirection(state, 40), 0);
});

test("direction follows the travel and survives a repeated index", () => {
  const state = createScrollDirectionState();
  trackScrollDirection(state, 40);
  assert.equal(trackScrollDirection(state, 41), 1);
  assert.equal(trackScrollDirection(state, 41), 1, "a re-render is not a stop");
  assert.equal(trackScrollDirection(state, 40), -1);
  assert.equal(trackScrollDirection(state, 20), -1);
  assert.equal(trackScrollDirection(state, 21), 1);
});

test("a non-finite index leaves the direction alone", () => {
  const state = createScrollDirectionState();
  trackScrollDirection(state, 10);
  trackScrollDirection(state, 11);
  assert.equal(trackScrollDirection(state, Number.NaN), 1);
  assert.equal(state.last, 11);
});

test("travel warm leads with the direction of travel, nearest first", () => {
  const forward = directionalPrefetchIndexes(240, 100, 1);
  assert.deepEqual(forward, [101, 102, 103, 104, 105, 99]);
  const backward = directionalPrefetchIndexes(240, 100, -1);
  assert.deepEqual(backward, [99, 98, 97, 96, 95, 101]);
});

test("no direction yet warms forward — a stack opens mid-series", () => {
  assert.deepEqual(directionalPrefetchIndexes(240, 100, 0), [101, 102, 103, 104, 105, 99]);
});

test("travel warm stays inside the stack at both ends", () => {
  assert.deepEqual(directionalPrefetchIndexes(10, 0, -1), [1]);
  assert.deepEqual(directionalPrefetchIndexes(10, 9, 1), [8]);
  for (const index of directionalPrefetchIndexes(10, 5, 1)) {
    assert.ok(index >= 0 && index <= 9, `${index} out of stack`);
  }
});

test("travel warm never includes the slice the reader is on, and never repeats", () => {
  const indexes = directionalPrefetchIndexes(240, 100, 1);
  assert.ok(!indexes.includes(100));
  assert.equal(new Set(indexes).size, indexes.length);
});

test("travel warm is small enough to issue on every slice change", () => {
  const indexes = directionalPrefetchIndexes(1200, 600, 1);
  assert.equal(indexes.length, TRAVEL_AHEAD + TRAVEL_BEHIND);
  assert.ok(indexes.length <= 8, "a per-slice queue must stay cheap");
});

test("travel warm is a no-op on a single-image stack", () => {
  assert.deepEqual(directionalPrefetchIndexes(1, 0, 1), []);
  assert.deepEqual(directionalPrefetchIndexes(0, 0, 1), []);
});

test("ahead and behind counts are overridable", () => {
  assert.deepEqual(directionalPrefetchIndexes(240, 100, 1, 2, 0), [101, 102]);
  assert.deepEqual(directionalPrefetchIndexes(240, 100, 1, 0, 2), [99, 98]);
  assert.deepEqual(directionalPrefetchIndexes(240, 100, 1, 0, 0), []);
});
