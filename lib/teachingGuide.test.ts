import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTeachingGuide,
  formatTeachingGuideLine,
  guideForFindingTrack,
  resolveTeachingGuide,
} from "./teachingGuide.ts";
import { measurementsFromTrack } from "./findingMeasurements.ts";
import type { RecordedTrack } from "./types.ts";

const track: RecordedTrack = {
  durationMs: 4000,
  start: { sliceIndex: 10, ww: 1500, wc: -600 },
  events: [
    { t: 0, type: "slice", index: 10 },
    { t: 40, type: "slice", index: 12 },
    { t: 80, type: "slice", index: 14 },
    { t: 600, type: "voi", ww: 1600, wc: -580 },
    { t: 700, type: "voi", ww: 400, wc: 40 },
    { t: 1200, type: "camera", zoom: 1.02, pan: [0, 0] },
    { t: 1300, type: "camera", zoom: 1.8, pan: [4, -2] },
    { t: 1800, type: "cursor", x: 0.2, y: 0.2 },
    { t: 1900, type: "cursor", x: 0.42, y: 0.55 },
    {
      t: 2200,
      type: "annotation",
      shape: "arrow",
      from: [0.4, 0.5],
      to: [0.62, 0.58],
      tool: "Length",
      handles: [
        [0.4, 0.5],
        [0.62, 0.58],
      ],
      sliceIndex: 14,
      annotationUID: "len-1",
      lengthMm: 12.4,
      unit: "mm",
    },
    {
      t: 2300,
      type: "annotation",
      shape: "arrow",
      from: [0.41, 0.5],
      to: [0.7, 0.6],
      tool: "Length",
      handles: [
        [0.41, 0.5],
        [0.7, 0.6],
      ],
      sliceIndex: 14,
      annotationUID: "len-1",
      lengthMm: 18,
      unit: "mm",
    },
  ],
};

test("buildTeachingGuide collapses scroll, window, zoom, point, and the final stroke", () => {
  const guide = buildTeachingGuide(track);
  const actions = guide.beats.flatMap((b) => b.actions);
  const scroll = actions.find((a) => a.type === "scroll");
  assert.equal(scroll && scroll.type === "scroll" ? scroll.sliceIndex : -1, 14);
  assert.equal(actions.filter((a) => a.type === "scroll").length, 1);
  const win = actions.find((a) => a.type === "window");
  assert.ok(win && win.type === "window");
  if (win && win.type === "window") {
    assert.equal(win.ww, 400);
    assert.equal(win.wc, 40);
  }
  const zoom = actions.find((a) => a.type === "zoom");
  assert.ok(zoom && zoom.type === "zoom" && zoom.zoom === 1.8);
  const point = actions.find((a) => a.type === "point");
  assert.ok(point && point.type === "point");
  if (point && point.type === "point") {
    assert.equal(point.x, 0.42);
    assert.equal(point.y, 0.55);
  }
  const draws = actions.filter((a) => a.type === "annotate");
  assert.equal(draws.length, 1);
  if (draws[0] && draws[0].type === "annotate") {
    assert.equal(draws[0].tool, "Length");
    assert.equal(draws[0].lengthMm, 18);
  }
});

test("guide narration is ordered with the gesture, not a stats line", () => {
  const guide = guideForFindingTrack(track, {
    description: "Soft tissue nodule. Measure it on lung windows.",
    teachingPoints: ["Window before you measure."],
  });
  const said = guide.beats.map((b) => b.say).filter(Boolean);
  assert.ok(said.length >= 1);
  assert.match(said.join(" "), /nodule/i);
  const line = formatTeachingGuideLine(guide);
  assert.match(line, /guide=\[/);
  assert.match(line, /scroll→14/);
  assert.match(line, /window\(400\/40\)/);
  assert.match(line, /draw\(Length\)/);
  assert.match(line, /say:/);
});

test("measurementsFromTrack keeps the last Length stroke", () => {
  const rows = measurementsFromTrack(track);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "length");
  assert.equal(rows[0].lengthMm, 18);
  assert.equal(rows[0].id, "len-1");
});

test("resolveTeachingGuide rebuilds from the track and current prose", () => {
  const guide = resolveTeachingGuide({
    description: "Effusion.",
    teachingPoints: [],
    track,
    teachingGuide: {
      durationMs: 1,
      start: { sliceIndex: 0 },
      beats: [{ t: 0, actions: [], say: "stale" }],
    },
  });
  assert.ok(guide);
  assert.match(guide!.beats.map((b) => b.say ?? "").join(" "), /Effusion/);
  assert.ok(guide!.beats.some((b) => b.actions.some((a) => a.type === "scroll")));
});

test("a dwell is a hold, and each gesture is a consultant line", () => {
  const slow: RecordedTrack = {
    durationMs: 5000,
    start: { sliceIndex: 2, ww: 400, wc: 40 },
    events: [
      { t: 0, type: "slice", index: 8 },
      { t: 1800, type: "voi", ww: 1500, wc: -600 },
      { t: 3200, type: "camera", zoom: 2.2, pan: [0, 0] },
      { t: 4500, type: "cursor", x: 0.7, y: 0.62 },
    ],
  };
  const guide = buildTeachingGuide(slow);
  assert.ok(guide.beats.some((b) => b.actions.some((a) => a.type === "pause")));
  const said = guide.beats.map((b) => b.say ?? "").join(" ");
  assert.match(said, /slice 8/);
  assert.match(said, /Lung windows/);
  assert.match(said, /Zoom in/);
  assert.match(said, /Look here/);
  assert.match(said, /Hold/);
  assert.match(formatTeachingGuideLine(guide), /hold\(/);
});
