import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANGING_LAYOUTS,
  hangSeries,
  layoutById,
  layoutsForSeriesCount,
  movePane,
  nextLayout,
  paneCount,
} from "./hangingLayout";

test("layout lookup falls back to single", () => {
  assert.equal(layoutById("2x2").cols, 2);
  assert.equal(layoutById("nope").id, "1x1");
  assert.equal(layoutById(null).id, "1x1");
  assert.equal(paneCount(layoutById("2x2")), 4);
});

test("a one-series case is not offered a 2×2", () => {
  assert.deepEqual(
    layoutsForSeriesCount(1).map((l) => l.id),
    ["1x1", "1x2", "2x1"]
  );
  assert.equal(layoutsForSeriesCount(3).length, HANGING_LAYOUTS.length);
  assert.deepEqual(layoutsForSeriesCount(0).map((l) => l.id), ["1x1"]);
});

test("G cycles within the offered layouts", () => {
  assert.equal(nextLayout("1x1", 1), "1x2");
  assert.equal(nextLayout("2x1", 1), "1x1");
  assert.equal(nextLayout("2x2", 4), "1x1");
  assert.equal(nextLayout("2x2", 1), "1x1", "an unoffered layout restarts the cycle");
});

test("new panes get series nobody is showing yet", () => {
  assert.deepEqual(hangSeries(layoutById("2x2"), 5, [], 0), [0, 1, 2, 3]);
  assert.deepEqual(hangSeries(layoutById("1x2"), 3, [], 2), [2, 0]);
});

test("existing hangings survive a layout change", () => {
  assert.deepEqual(hangSeries(layoutById("2x2"), 4, [3, 1], 0), [3, 1, 0, 2]);
  assert.deepEqual(hangSeries(layoutById("1x1"), 4, [3, 1, 0, 2], 0), [3]);
});

test("fewer series than panes repeats rather than leaving a hole", () => {
  assert.deepEqual(hangSeries(layoutById("1x2"), 1), [0, 0]);
  assert.deepEqual(hangSeries(layoutById("2x2"), 2), [0, 1, 1, 1]);
  assert.deepEqual(hangSeries(layoutById("2x2"), 0), [0, 0, 0, 0]);
});

test("stale indexes from another case are dropped", () => {
  assert.deepEqual(hangSeries(layoutById("1x2"), 2, [7, -1], 0), [0, 1]);
});

test("arrow moves between panes and stops at the edge", () => {
  const grid = layoutById("2x2");
  assert.equal(movePane(grid, 0, "right"), 1);
  assert.equal(movePane(grid, 1, "right"), 1);
  assert.equal(movePane(grid, 1, "down"), 3);
  assert.equal(movePane(grid, 3, "left"), 2);
  assert.equal(movePane(grid, 2, "up"), 0);
});
