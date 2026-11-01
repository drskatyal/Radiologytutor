import assert from "node:assert/strict";
import { test } from "node:test";
import { cutPlaneFor, keeps, surfaceTransfer } from "../packages/viewer-core/src/volume3d";

const bounds = [-200, 200, -150, 150, -400, 0] as const;

test("cut plane: axial halfway keeps the superior half; flip keeps the inferior", () => {
  const p = cutPlaneFor(bounds, "axial", 0.5);
  assert.deepEqual(p.origin, [0, 0, -200]);
  assert.deepEqual(p.normal, [0, 0, 1]);
  assert.equal(keeps(p, [0, 0, -100]), true);
  assert.equal(keeps(p, [0, 0, -300]), false);
  const f = cutPlaneFor(bounds, "axial", 0.25, true);
  assert.deepEqual(f.origin, [0, 0, -100]);
  assert.equal(keeps(f, [0, 0, -300]), true);
  assert.equal(keeps(f, [0, 0, -50]), false);
});

test("cut plane: 0 keeps everything, 1 nothing; coronal and sagittal axes", () => {
  assert.equal(keeps(cutPlaneFor(bounds, "coronal", 0), [0, -150, 0]), true);
  assert.equal(keeps(cutPlaneFor(bounds, "sagittal", 1), [199, 0, 0]), false);
  assert.deepEqual(cutPlaneFor(bounds, "sagittal", 0.5).normal, [1, 0, 0]);
  assert.deepEqual(cutPlaneFor(bounds, "coronal", 2).origin, [0, 150, -200]); // clamped
});

test("surface transfer: a sharp opacity step at the threshold, clamped to the data range", () => {
  const s = surfaceTransfer(250, [-1024, 3071]);
  assert.deepEqual(s.opacity, [[-1024, 0], [240, 0], [260, 1], [3071, 1]]);
  assert.equal(surfaceTransfer(5000, [0, 1000]).opacity[1][0], 990);
  assert.equal(s.color.length, 3);
});
