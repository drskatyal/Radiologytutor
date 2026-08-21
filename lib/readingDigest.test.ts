import { test } from "node:test";
import assert from "node:assert/strict";
import {
  digestReadingTrack,
  formatReadingDigestLine,
} from "./readingDigest.ts";
import type { RecordedTrack } from "./types.ts";

const track: RecordedTrack = {
  durationMs: 12000,
  start: { sliceIndex: 10, ww: 1500, wc: -600 },
  events: [
    { t: 0, type: "slice", index: 10 },
    { t: 200, type: "slice", index: 12 },
    { t: 400, type: "slice", index: 14 },
    { t: 600, type: "voi", ww: 400, wc: 40 },
    { t: 800, type: "camera", zoom: 1.2, pan: [0, 0] },
    { t: 1000, type: "camera", zoom: 1.8, pan: [2, 1] },
    { t: 1200, type: "cursor", x: 0.4, y: 0.5 },
    { t: 1400, type: "annotation", shape: "circle", from: [0.4, 0.5], to: [0.45, 0.55] },
  ],
};

test("digestReadingTrack summarizes scroll, window, zoom, and gestures", () => {
  const d = digestReadingTrack(track);
  assert.equal(d.durationMs, 12000);
  assert.equal(d.startSlice, 10);
  assert.equal(d.sliceMin, 10);
  assert.equal(d.sliceMax, 14);
  assert.equal(d.sliceSteps, 3);
  assert.equal(d.startWw, 1500);
  assert.equal(d.endWw, 400);
  assert.equal(d.zoomMin, 1.2);
  assert.equal(d.zoomMax, 1.8);
  assert.equal(d.cursorSamples, 1);
  assert.equal(d.annotationStrokes, 1);
});

test("formatReadingDigestLine is compact tutor context", () => {
  const line = formatReadingDigestLine(digestReadingTrack(track));
  assert.match(line, /read=12s/);
  assert.match(line, /scroll\(slices=10\.\.14/);
  assert.match(line, /windowed\(/);
  assert.match(line, /zoom=/);
  assert.match(line, /pointed/);
  assert.match(line, /drew=1/);
});
