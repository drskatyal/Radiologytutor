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
