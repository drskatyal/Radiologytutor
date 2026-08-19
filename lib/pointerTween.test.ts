import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPointerPath,
  defaultApproachFrom,
  easeOutCubic,
} from "./pointerTween.ts";

test("easeOutCubic starts at 0 and ends at 1", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
});

test("easeOutCubic is monotonic and clamped", () => {
  assert.equal(easeOutCubic(-1), 0);
  assert.equal(easeOutCubic(2), 1);
  assert.ok(easeOutCubic(0.5) > 0.5);
});

test("buildPointerPath lands exactly on the target", () => {
  const to = { x: 0.62, y: 0.41 };
  const path = buildPointerPath(to, { durationMs: 400, sampleMs: 40 });
  const last = path[path.length - 1];
  assert.deepEqual(last, to);
  assert.ok(path.length > 3);
});

test("buildPointerPath stays within [0,1] for default approach", () => {
  const to = { x: 0.05, y: 0.05 };
  const from = defaultApproachFrom(to);
  assert.ok(from.x >= 0);
  assert.ok(from.y >= 0);
  const path = buildPointerPath(to);
  for (const p of path) {
    assert.ok(p.x >= 0 && p.x <= 1);
    assert.ok(p.y >= 0 && p.y <= 1);
  }
});

test("playPointerPath never crashes on empty or sparse timing", async () => {
  const { playPointerPath } = await import("./pointerTween.ts");
  // Node test runner has no rAF — polyfill a single-shot clock.
  let t = 0;
  (globalThis as { requestAnimationFrame?: (cb: (n: number) => void) => number }).requestAnimationFrame = (
    cb
  ) => {
    t += 50;
    return setTimeout(() => cb(t), 0) as unknown as number;
  };
  (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame = (id) => {
    clearTimeout(id);
  };

  const pts: { x: number; y: number }[] = [];
  const { done } = playPointerPath([], (x, y) => pts.push({ x, y }));
  await done;
  assert.equal(pts.length, 0);

  const path = buildPointerPath({ x: 0.5, y: 0.5 }, { durationMs: 120, sampleMs: 40 });
  const seen: { x: number; y: number }[] = [];
  const run = playPointerPath(path, (x, y) => seen.push({ x, y }));
  await run.done;
  assert.ok(seen.length >= 1);
  assert.equal(seen[seen.length - 1].x, 0.5);
});

test("buildPointerPath tolerates non-finite targets", () => {
  const path = buildPointerPath({ x: Number.NaN, y: Number.POSITIVE_INFINITY });
  assert.ok(path.length > 0);
  assert.equal(path[path.length - 1].x, 0.5);
  assert.equal(path[path.length - 1].y, 0.5);
});
