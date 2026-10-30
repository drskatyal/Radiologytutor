import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MIN_THUMB_PX,
  clampIndex,
  indexFromFraction,
  indexFromPointer,
  scrollbarFraction,
  sliceStepForKey,
  thumbGeometry,
} from "./sliceScrollbar";

test("the fraction runs 0 at the first slice to 1 at the last", () => {
  assert.equal(scrollbarFraction(0, 240), 0);
  assert.equal(scrollbarFraction(239, 240), 1);
  assert.equal(scrollbarFraction(119, 240), 119 / 239);
});

test("a single-image stack has nothing to scroll", () => {
  assert.equal(scrollbarFraction(0, 1), 0);
  assert.equal(scrollbarFraction(5, 1), 0);
  assert.equal(indexFromFraction(0.7, 1), 0);
  assert.equal(indexFromFraction(0.7, 0), 0);
});

test("fraction and index round-trip", () => {
  for (const count of [2, 10, 240, 1201]) {
    for (const index of [0, 1, Math.floor(count / 2), count - 1]) {
      assert.equal(
        indexFromFraction(scrollbarFraction(index, count), count),
        index,
        `count=${count} index=${index}`
      );
    }
  }
});

test("indexes and fractions are clamped, never thrown", () => {
  assert.equal(clampIndex(-10, 240), 0);
  assert.equal(clampIndex(9_999, 240), 239);
  assert.equal(clampIndex(Number.NaN, 240), 0);
  assert.equal(indexFromFraction(-1, 240), 0);
  assert.equal(indexFromFraction(2, 240), 239);
  assert.equal(indexFromFraction(Number.NaN, 240), 0);
});

test("dragging the thumb to the very bottom reaches the last slice", () => {
  const track = { top: 100, height: 400 };
  assert.equal(indexFromPointer(100 + 400, track, 240), 239, "pointer at the bottom edge");
  assert.equal(indexFromPointer(100, track, 240), 0, "pointer at the top edge");
});

test("the pointer maps through the thumb's travel, not the raw track", () => {
  // A 24px thumb on a 400px track has 376px of travel; the midpoint of the
  // travel must be the middle slice, not the midpoint of the track.
  const track = { top: 0, height: 400 };
  const middle = indexFromPointer(MIN_THUMB_PX / 2 + 376 / 2, track, 241);
  assert.equal(middle, 120);
});

test("a pointer outside the track clamps instead of overshooting", () => {
  const track = { top: 50, height: 200 };
  assert.equal(indexFromPointer(-500, track, 60), 0);
  assert.equal(indexFromPointer(5_000, track, 60), 59);
});

test("a zero-height track resolves to the first slice", () => {
  assert.equal(indexFromPointer(10, { top: 0, height: 0 }, 60), 0);
});

test("the thumb shows how long the series is but stays grabbable", () => {
  const long = thumbGeometry(600, 1200, 400);
  assert.ok(long.heightPct >= (MIN_THUMB_PX / 400) * 100, "floored at MIN_THUMB_PX");
  const short = thumbGeometry(1, 4, 400);
  assert.equal(short.heightPct, 25, "a quarter of a 4-image stack");
  assert.ok(short.heightPct > long.heightPct, "a short series has a taller thumb");
});

test("the thumb never runs off either end of the track", () => {
  for (const count of [3, 60, 1200]) {
    for (const index of [0, Math.floor(count / 2), count - 1]) {
      const { topPct, heightPct } = thumbGeometry(index, count, 400);
      assert.ok(topPct >= 0, `top ${topPct}`);
      assert.ok(topPct + heightPct <= 100.0001, `bottom ${topPct + heightPct}`);
    }
  }
  assert.equal(thumbGeometry(0, 240, 400).topPct, 0);
});

test("a stack with nothing to scroll fills the track", () => {
  assert.deepEqual(thumbGeometry(0, 1, 400), { topPct: 0, heightPct: 100 });
  assert.deepEqual(thumbGeometry(0, 240, 0), { topPct: 0, heightPct: 100 });
});

test("arrows move one slice and Shift moves a twentieth of the series", () => {
  assert.equal(sliceStepForKey("ArrowDown", 240), 1);
  assert.equal(sliceStepForKey("ArrowUp", 240), -1);
  assert.equal(sliceStepForKey("ArrowDown", 240, { shift: true }), 12);
  assert.equal(sliceStepForKey("PageDown", 240), 12);
  assert.equal(sliceStepForKey("PageUp", 240), -12);
});

test("the coarse step is at least two slices even on a short series", () => {
  assert.equal(sliceStepForKey("PageDown", 4), 2);
  assert.equal(sliceStepForKey("PageDown", 0), 2);
});

test("a key the scrollbar does not own passes through", () => {
  assert.equal(sliceStepForKey("Space", 240), null);
  assert.equal(sliceStepForKey("a", 240), null);
  assert.equal(sliceStepForKey("Enter", 240), null);
});
