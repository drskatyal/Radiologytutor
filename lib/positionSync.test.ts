import assert from "node:assert/strict";
import { test } from "node:test";
import { nearestIndex, positionsAlong, sliceNormalOf, syncTargetIndex } from "../packages/viewer-core/src/positionSync";

const axial = sliceNormalOf([1, 0, 0, 0, 1, 0])!;
const zs = (start: number, step: number, n: number) => Array.from({ length: n }, (_, i) => [0, 0, start + i * step]);

test("positions along the normal, nearest slice", () => {
  assert.deepEqual(axial, [0, 0, 1]);
  const p = positionsAlong(zs(-100, 2.5, 5), axial);
  assert.deepEqual(p, [-100, -97.5, -95, -92.5, -90]);
  assert.equal(nearestIndex(p, -96), 2);
});

test("thin vs thick stacks of the same scan meet at the same anatomy", () => {
  const thin = { positions: positionsAlong(zs(-200, 1, 201), axial), normal: axial };
  const thick = { positions: positionsAlong(zs(-200, 5, 41), axial), normal: axial };
  assert.equal(syncTargetIndex(thin, 100, thick), 20); // z = -100 on both
});

test("prior with a registration offset", () => {
  const current = { positions: positionsAlong(zs(-400, 1, 301), axial), normal: axial }; // -400..-100
  // Prior sits 10 mm higher in its own frame: prior z = current z + 10.
  const prior = { positions: positionsAlong(zs(-390, 1, 301), axial), normal: axial, offsetMm: -10 };
  assert.equal(syncTargetIndex(current, 0, prior), 0); // current -400 ↔ prior -390
  assert.equal(syncTargetIndex(prior, 50, current), 50);
});

test("non-parallel or position-less stacks fall back to the stack fraction", () => {
  const ax = { positions: [0, 1, 2, 3, 4], normal: axial };
  const cor = { positions: [0, 1, 2, 3, 4, 5, 6, 7, 8], normal: sliceNormalOf([1, 0, 0, 0, 0, -1]) };
  assert.equal(syncTargetIndex(ax, 4, cor), 8);
  assert.equal(syncTargetIndex({ positions: [NaN, NaN, NaN] }, 1, { positions: [NaN, NaN, NaN, NaN, NaN] }), 2);
  assert.equal(syncTargetIndex(ax, 0, { positions: [] }), -1);
});
