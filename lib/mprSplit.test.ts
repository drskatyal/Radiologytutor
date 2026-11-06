import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EQUAL_SHARES, MIN_SHARE, moveSplit } from "./mprSplit";

const sum = (s: readonly number[]) => s.reduce((a, b) => a + b, 0);
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("the MPR layout starts as three equal panes", () => {
  assert.equal(EQUAL_SHARES.length, 3);
  for (const s of EQUAL_SHARES) close(s, 1 / 3);
});

test("a splitter moves only its two neighbours and keeps the total", () => {
  const next = moveSplit(EQUAL_SHARES, 0, 0.1);
  close(next[0], 1 / 3 + 0.1);
  close(next[1], 1 / 3 - 0.1);
  close(next[2], 1 / 3);
  close(sum(next), 1);
  const back = moveSplit(next, 1, -0.05);
  close(back[0], next[0]);
  close(back[1], next[1] - 0.05);
  close(back[2], next[2] + 0.05);
});

test("no pane can be dragged below the minimum share", () => {
  const left = moveSplit(EQUAL_SHARES, 0, -1);
  close(left[0], MIN_SHARE);
  close(left[1], 2 / 3 - MIN_SHARE);
  const right = moveSplit(EQUAL_SHARES, 1, 5);
  close(right[2], MIN_SHARE);
  close(sum(right), 1);
});
