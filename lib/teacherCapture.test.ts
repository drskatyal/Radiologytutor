import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTIC_VIDEO_MIN_MS,
  compileProgressPlan,
  phaseAfterFinish,
  reviewTimeline,
  useAgenticViewportVideo,
} from "./teacherCapture.ts";
import type { RecordedTrack } from "./types.ts";

test("finish holds a voiced take for review and does not compile", () => {
  assert.equal(phaseAfterFinish({ hasTrack: true, hasAudio: true }), "review");
  assert.equal(phaseAfterFinish({ hasTrack: true, hasAudio: false }), "notes");
  assert.equal(phaseAfterFinish({ hasTrack: false, hasAudio: false }), "empty");
});

test("agentic video starts at five minutes", () => {
  assert.equal(useAgenticViewportVideo(AGENTIC_VIDEO_MIN_MS - 1), false);
  assert.equal(useAgenticViewportVideo(AGENTIC_VIDEO_MIN_MS), true);
  assert.equal(useAgenticViewportVideo(10 * 60 * 1000), true);
});

test("compile progress names the viewport upload only for a long take", () => {
  const short = compileProgressPlan(false);
  const long = compileProgressPlan(true);
  assert.equal(short.length, 4);
  assert.equal(short[1], "Sending the viewer log");
  assert.equal(long[1], "Uploading the viewport recording");
  assert.equal(long[2], "Compiling with Gemini");
});

test("review timeline names log events and hides pointer coordinates", () => {
  const track: RecordedTrack = {
    durationMs: 3000,
    start: { sliceIndex: 1 },
    events: [
      { t: 400, type: "cursor", x: 0.91, y: 0.08 },
      { t: 800, type: "slice", index: 6 },
      { t: 1200, type: "compare", open: true, sliceIndex: 9, x: 0.2, y: 0.3 },
      { t: 1600, type: "series", seriesInstanceUID: "1.2.3" },
    ],
  };
  const marks = reviewTimeline(track);
  const text = marks.map((mark) => mark.label).join(" ");
  assert.match(text, /Slice 2/);
  assert.match(text, /Slice 7/);
  assert.match(text, /Compare/);
  assert.match(text, /Series/);
  assert.doesNotMatch(text, /0\.91/);
  assert.doesNotMatch(text, /1\.2\.3/);
});
