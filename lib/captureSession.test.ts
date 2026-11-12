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

test("M4 child track retains full rendered identity/camera/layout and signed parent audio offset", () => {
  const snapshot = {
    studyUID: "study", seriesUID: "series", sopUID: "sop", frame: 3, viewportId: "primary", layout: "1x1",
    voi: { ww: 800, wc: 100 }, invert: true,
    camera: { zoom: 2, pan: [3, 4] as [number, number], rotation: 90, flipH: true, flipV: false },
    orientation: { normal: [0, 0, 1], up: [0, -1, 0] }, renderSeq: 7,
  };
  const parent: RecordedTrack = { ...track, captureSessionId: "capture", audioOffsetMs: 250, videoOffsetMs: 100,
    journal: [{ seq: 0, kind: "render", t: 400, renderSeq: 7, snapshot }, { seq: 1, kind: "input", t: 800 }] };
  const sub = sliceTrack(parent, 500, 2600);
  assert.deepEqual(sub.start.snapshot, snapshot);
  assert.equal(sub.start.seriesInstanceUID, "series"); assert.equal(sub.start.sopInstanceUID, "sop");
  assert.equal(sub.start.frameNumber, 3); assert.deepEqual(sub.start.pan, [3, 4]);
  assert.equal(sub.start.zoom, 2); assert.equal(sub.start.invert, true); assert.equal(sub.start.rotation, 90);
  assert.equal(sub.start.flipH, true); assert.equal(sub.start.layout, "1x1");
  assert.equal(sub.audioOffsetMs, -250); assert.equal(sub.videoOffsetMs, -400);
  assert.equal(sub.journal?.[0].t, 300);
  assert.equal(sub.captureSessionId, "capture");
  sub.start.snapshot!.camera.pan[0] = 99;
  assert.equal(snapshot.camera.pan[0], 3, "child must not mutate parent evidence");
});
