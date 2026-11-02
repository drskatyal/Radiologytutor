import { test } from "node:test";
import assert from "node:assert/strict";
import { fillBudget, outwardOrder, runBounded } from "./seriesFill";

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

test("bounded fill: never more than `concurrency` in flight, in order", async () => {
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  await runBounded(
    Array.from({ length: 20 }, (_, i) => i),
    async (i) => {
      started.push(i);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    },
    { signal: new AbortController().signal, concurrency: 3 }
  );
  assert.equal(peak, 3);
  assert.deepEqual(started, Array.from({ length: 20 }, (_, i) => i));
});

test("bounded fill: abort stops unstarted items (a closed study stops reading)", async () => {
  const controller = new AbortController();
  const started: number[] = [];
  const done = runBounded(
    Array.from({ length: 100 }, (_, i) => i),
    async (i) => {
      started.push(i);
      if (i === 5) controller.abort();
      await new Promise((r) => setTimeout(r, 1));
    },
    { signal: controller.signal, concurrency: 4 }
  );
  await done;
  assert.ok(started.length <= 9, `started ${started.length}`);
  assert.ok(!started.includes(50));
});

test("bounded fill: a throw or rejection skips only that item", async () => {
  const seen: number[] = [];
  await runBounded(
    [1, 2, 3, 4],
    (i) => {
      seen.push(i);
      if (i === 2) throw new Error("no metadata");
      if (i === 3) return Promise.reject(new Error("decode failed"));
      return undefined;
    },
    { signal: new AbortController().signal, concurrency: 1 }
  );
  assert.deepEqual(seen, [1, 2, 3, 4]);
});
