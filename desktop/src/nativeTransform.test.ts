// Mirrors native_view.rs tests: the page and Rust must map pixels identically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCell, toImage, transformFor, type NativeView } from "./native/transform";

const base: NativeView = { index: 0, wl: [40, 400], zoom: 1, pan: [0, 0], rotation: 0, flipH: false, flipV: false, invert: false };
const near = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;

test("fits and centres (as Rust)", () => {
  const t = transformFor(base, 512, 512, 800, 600);
  assert.ok(Math.abs(t.scale - 600 / 512) < 1e-9);
  assert.ok(near(toCell(t, 256, 256), [400, 300]));
  assert.ok(near(toCell(t, 0, 0), [100, 0]));
  assert.ok(near(toCell(t, 512, 512), [700, 600]));
});

test("clockwise rotation round-trips (as Rust)", () => {
  const t = transformFor({ ...base, rotation: 90 }, 400, 200, 400, 400);
  const tl = toCell(t, 0, 0);
  assert.ok(tl[0] > 200 && tl[1] < 200);
  for (const [c, r] of [[0, 0], [123, 45], [399, 199]] as const) assert.ok(near(toImage(t, ...toCell(t, c, r)), [c, r]));
});

test("zoom, pan, flip, 270° round-trip (as Rust)", () => {
  const t = transformFor({ ...base, zoom: 2.5, pan: [30, -12], flipH: true, flipV: true, rotation: 270 }, 512, 384, 640, 480);
  for (const [c, r] of [[1, 2], [256, 192], [500, 10]] as const) assert.ok(near(toImage(t, ...toCell(t, c, r)), [c, r]));
});
