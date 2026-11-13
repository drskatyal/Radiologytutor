import { test } from "node:test";
import assert from "node:assert/strict";
import { forEachLimited } from "./pool";

const tick = () => new Promise((r) => setTimeout(r, 1));

test("runs every item with at most `limit` in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const seen: number[] = [];
  await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick();
    seen.push(n);
    inFlight--;
  });
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
});

test("first throw stops new work and rejects after in-flight steps settle", async () => {
  const started: number[] = [];
  await assert.rejects(
    forEachLimited([1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      await tick();
      if (n === 1) throw new Error("boom");
    }),
    /boom/
  );
  assert.ok(started.length < 5, "no new items after the failure");
});

test("shouldStop halts before the next item; empty input is a no-op", async () => {
  let ran = 0;
  await forEachLimited([1, 2, 3], 1, async () => void ran++, () => ran >= 2);
  assert.equal(ran, 2);
  await forEachLimited([], 4, async () => assert.fail("never"));
});
