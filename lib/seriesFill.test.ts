import { test } from "node:test";
import assert from "node:assert/strict";
import { fillBudget, outwardOrder } from "./seriesFill";

test("outward from the reader, nearest first, alternating", () => {
  assert.deepEqual(outwardOrder(10, 5), [6, 4, 7, 3, 8, 2, 9, 1, 0]);
});

test("covers the whole series exactly once from either end", () => {
  for (const center of [0, 423, 847]) {
    const order = outwardOrder(848, center);
    assert.equal(order.length, 847);
    assert.equal(new Set(order).size, 847);
    assert.ok(!order.includes(center));
  }
});

test("limit caps the queue", () => {
  assert.deepEqual(outwardOrder(100, 50, 3), [51, 49, 52]);
  assert.deepEqual(outwardOrder(1, 0), []);
  assert.deepEqual(outwardOrder(10, 5, 0), []);
});

test("budget: a 512² CT fits whole in a 1 GB cache, a phone gets a window", () => {
  const slice = 512 * 512 * 2;
  assert.equal(fillBudget(848, slice, 1024 * 1024 * 1024), 847);
  const phone = fillBudget(848, slice, 192 * 1024 * 1024);
  assert.ok(phone > 200 && phone < 848, String(phone));
  assert.equal(fillBudget(848, 0, 1e9), 0);
});
