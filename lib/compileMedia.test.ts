import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPILE_FRAME_LIMIT,
  COMPILING_FROM_RECORDING,
  fitEdge,
  largestCanvas,
  prepareCompileFrames,
  pushViewportStill,
  rasterizeGrayscale,
  snapshotHasDetail,
  trackClockSummary,
  type CompileFrame,
} from "./compileMedia.ts";
import type { RecordedTrack } from "./types.ts";

const track: RecordedTrack = {
  durationMs: 4000,
  start: { sliceIndex: 4, ww: 1500, wc: -600 },
  events: [
    { t: 400, type: "cursor", x: 0.13, y: 0.87 },
    { t: 900, type: "slice", index: 18 },
    { t: 1200, type: "camera", zoom: 2.2, pan: [12, -6] },
    { t: 1600, type: "voi", ww: 400, wc: 40 },
    { t: 2000, type: "annotation", shape: "arrow", from: [0.1, 0.2], to: [0.3, 0.4] },
  ],
};

test("compile status names the recording, not a transcription step", () => {
  assert.equal(COMPILING_FROM_RECORDING, "Compiling from recording…");
  assert.doesNotMatch(COMPILING_FROM_RECORDING, /Transcrib/i);
});

test("track clock names gestures and withholds pointer coordinates", () => {
  const clock = trackClockSummary(track);
  assert.match(clock, /t=0ms slice 4/);
  assert.match(clock, /t=900ms slice 18/);
  assert.match(clock, /t=400ms pointer/);
  assert.match(clock, /t=1200ms camera/);
  assert.match(clock, /t=1600ms window/);
  assert.match(clock, /t=2000ms annotation/);
  assert.doesNotMatch(clock, /0\.13/);
  assert.doesNotMatch(clock, /0\.87/);
  assert.doesNotMatch(clock, /2\.2/);
  assert.equal(trackClockSummary(undefined), "");
});

test("prepareCompileFrames keeps a spread of usable stills and drops junk", () => {
  const frames: CompileFrame[] = [
    { tMs: 3000, mimeType: "image/jpeg", base64: "A".repeat(40) },
    { tMs: 0, mimeType: "image/png", base64: "data:image/png;base64," + "B".repeat(40) },
    { tMs: 1000, mimeType: "audio/webm", base64: "C".repeat(40) },
    { tMs: 2000, mimeType: "image/jpeg", base64: "tiny" },
    { tMs: 4000, mimeType: "image/webp", base64: "D".repeat(200_000) },
    { tMs: Number.NaN, mimeType: "image/jpeg", base64: "E".repeat(40) },
  ];
  const kept = prepareCompileFrames(frames);
  assert.deepEqual(
    kept.map((frame) => frame.tMs),
    [0, 3000]
  );
  assert.equal(kept[0]?.mimeType, "image/png");
  assert.equal(kept[0]?.base64, "B".repeat(40));
  assert.equal(kept[1]?.mimeType, "image/jpeg");
});

test("prepareCompileFrames spreads a long strip down to the send budget", () => {
  const frames: CompileFrame[] = Array.from({ length: 10 }, (_, i) => ({
    tMs: i * 1000,
    mimeType: "image/jpeg",
    base64: "F".repeat(48),
  }));
  const kept = prepareCompileFrames(frames);
  assert.equal(kept.length, COMPILE_FRAME_LIMIT);
  assert.equal(kept[0]?.tMs, 0);
  assert.equal(kept[kept.length - 1]?.tMs, 9000);
  assert.deepEqual(
    kept.map((frame) => frame.tMs),
    [...kept.map((frame) => frame.tMs)].sort((a, b) => a - b)
  );
});

test("pushViewportStill caps the in-memory strip without dropping the landing", () => {
  let frames: CompileFrame[] = [];
  for (let i = 0; i < 30; i++) {
    frames = pushViewportStill(frames, {
      tMs: i * 500,
      mimeType: "image/jpeg",
      base64: "G".repeat(48),
    });
  }
  assert.ok(frames.length <= 24);
  assert.equal(frames[0]?.tMs, 0);
  assert.equal(frames[frames.length - 1]?.tMs, 29 * 500);
});

test("largestCanvas prefers the imaging surface over a small overlay", () => {
  const overlay = { width: 16, height: 16 };
  const imaging = { width: 512, height: 512 };
  assert.equal(largestCanvas([overlay, imaging]), imaging);
  assert.equal(largestCanvas([]), null);
});

test("fitEdge scales the long side down to the still budget", () => {
  assert.deepEqual(fitEdge(1024, 512, 480), { width: 480, height: 240 });
  assert.deepEqual(fitEdge(0, 512, 480), { width: 0, height: 0 });
});

test("snapshotHasDetail accepts a real CT gradient and rejects a cleared buffer", () => {
  const cleared = new Uint8ClampedArray(64);
  assert.equal(snapshotHasDetail(cleared), false);
  const ink = new Uint8ClampedArray(64);
  ink[0] = 12;
  ink[1] = 12;
  ink[2] = 12;
  ink[3] = 255;
  ink[20] = 180;
  ink[21] = 180;
  ink[22] = 180;
  ink[23] = 255;
  assert.equal(snapshotHasDetail(ink, 1), true);
});

test("rasterizeGrayscale windows stored pixels and never invents a color outside the VOI", () => {
  const rgba = rasterizeGrayscale({
    columns: 4,
    rows: 1,
    samples: [0, 100, 200, 400],
    slope: 1,
    intercept: 0,
    ww: 300,
    wc: 150,
  });
  assert.ok(rgba);
  assert.equal(rgba.length, 4 * 4);
  assert.equal(rgba[0], 0);
  assert.equal(rgba[4], 85);
  assert.equal(rgba[8], 170);
  assert.equal(rgba[12], 255);
  assert.equal(rgba[3], 255);
  assert.equal(rasterizeGrayscale({ columns: 0, rows: 1, samples: [], slope: 1, intercept: 0, ww: 1, wc: 0 }), null);
});
