import { test } from "node:test";
import assert from "node:assert/strict";
import { clickDistance, clickHitsFinding } from "./clickFinding.ts";
import type { Marker } from "./types.ts";

const marker: Marker = { x_pct: 0.42, y_pct: 0.48, shape: "circle" };

test("clickDistance is 0 on the marker", () => {
  assert.equal(clickDistance(marker, 0.42, 0.48), 0);
});

test("clickHitsFinding accepts a nearby click and rejects a far one", () => {
  assert.equal(clickHitsFinding(marker, 0.44, 0.5), true);
  assert.equal(clickHitsFinding(marker, 0.9, 0.9), false);
  assert.equal(clickHitsFinding(null, 0.42, 0.48), false);
});
