import { test } from "node:test";
import assert from "node:assert/strict";
import { markerFromTrack } from "../components/author/lib.ts";
import type { RecordedTrack } from "./types.ts";

test("markerFromTrack returns null for empty / missing tracks", () => {
  assert.equal(markerFromTrack(null), null);
  assert.equal(markerFromTrack(undefined), null);
  assert.equal(
    markerFromTrack({ durationMs: 100, start: { sliceIndex: 0 }, events: [] }),
    null
  );
});

test("markerFromTrack uses the last cursor sample", () => {
  const track: RecordedTrack = {
    durationMs: 500,
    start: { sliceIndex: 1 },
    events: [
      { t: 10, type: "cursor", x: 0.2, y: 0.3 },
      { t: 20, type: "slice", index: 2 },
      { t: 30, type: "cursor", x: 0.71, y: 0.44 },
    ],
  };
  assert.deepEqual(markerFromTrack(track), {
    x_pct: 0.71,
    y_pct: 0.44,
    shape: "circle",
  });
});
