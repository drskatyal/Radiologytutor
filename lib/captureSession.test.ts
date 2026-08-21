import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markerNearTime,
  segmentMidMs,
  sliceNearTime,
  sliceTrack,
} from "./captureSession.ts";
import type { RecordedTrack } from "./types.ts";

const track: RecordedTrack = {
  durationMs: 10000,
  start: { sliceIndex: 0, ww: 400, wc: 40 },
  events: [
    { t: 100, type: "cursor", x: 0.2, y: 0.3 },
    { t: 500, type: "slice", index: 2 },
    { t: 800, type: "cursor", x: 0.55, y: 0.4 },
    { t: 2000, type: "slice", index: 4 },
    { t: 2500, type: "cursor", x: 0.7, y: 0.6 },
  ],
};

test("segmentMidMs averages the window", () => {
  assert.equal(segmentMidMs(100, 300), 200);
});

test("markerNearTime picks last cursor at or before t", () => {
  assert.deepEqual(markerNearTime(track, 900), {
    x_pct: 0.55,
    y_pct: 0.4,
    shape: "circle",
  });
  assert.deepEqual(markerNearTime(track, 50), {
    x_pct: 0.2,
    y_pct: 0.3,
    shape: "circle",
  });
});

test("sliceNearTime follows slice events", () => {
  assert.equal(sliceNearTime(track, 100), 0);
  assert.equal(sliceNearTime(track, 600), 2);
  assert.equal(sliceNearTime(track, 3000), 4);
});

test("sliceTrack rebases events into a window", () => {
  const sub = sliceTrack(track, 500, 2600);
  assert.equal(sub.start.sliceIndex, 2);
  assert.ok(sub.events.every((e) => e.t >= 0 && e.t <= 2100));
  assert.equal(sub.events[0]?.type, "slice");
});
