import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTeachingGuide,
  coerceNarrationSpans,
  formatTeachingGuideLine,
  guideForFindingTrack,
  resolveTeachingGuide,
  spansFromTranscript,
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

test("settled gestures are attending acts, not a hold between fumbles", () => {
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
  assert.equal(
    guide.beats.some((b) => b.actions.some((a) => a.type === "pause")),
    false
  );
  assert.deepEqual(
    guide.beats.map((b) => b.act),
    ["orient", "search", "lean-in", "commit", "pearl"]
  );
  const orient = guide.beats.find((b) => b.act === "orient");
  const search = guide.beats.find((b) => b.act === "search");
  const lean = guide.beats.find((b) => b.act === "lean-in");
  const commit = guide.beats.find((b) => b.act === "commit");
  assert.match(orient?.say ?? "", /^Follow the stack/);
  assert.match(search?.say ?? "", /Lung windows/);
  assert.match(lean?.say ?? "", /Lean in/);
  assert.match(commit?.say ?? "", /Look here/);
  const said = guide.beats.map((b) => b.say ?? "").join(" ");
  assert.doesNotMatch(said, /Hold/);
  assert.match(formatTeachingGuideLine(guide), /orient/);
});

test("fumbles are dropped; the committed slice, window, and point are the acts", () => {
  const fumbling: RecordedTrack = {
    durationMs: 6000,
    start: { sliceIndex: 0, ww: 400, wc: 40 },
    events: [
      { t: 100, type: "slice", index: 3 },
      { t: 200, type: "slice", index: 9 },
      { t: 500, type: "slice", index: 8 },
      { t: 800, type: "voi", ww: 2000, wc: 300 },
      { t: 1500, type: "voi", ww: 1500, wc: -600 },
      { t: 2000, type: "camera", zoom: 3.4, pan: [0, 0] },
      { t: 2600, type: "camera", zoom: 1.04, pan: [0, 0] },
      { t: 3000, type: "cursor", x: 0.1, y: 0.1 },
      { t: 3600, type: "cursor", x: 0.28, y: 0.22 },
    ],
  };
  const guide = buildTeachingGuide(fumbling, {
    anchors: {
      sliceIndex: 8,
      ww: 1500,
      wc: -600,
      point: { x: 0.28, y: 0.22 },
      label: "Right apical pneumothorax",
      description: "Visceral pleural line at the right apex.",
      teachingPoints: ["No lung markings beyond it."],
    },
  });
  const actions = guide.beats.flatMap((b) => b.actions);
  const scrolls = actions.filter((a) => a.type === "scroll");
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0] && scrolls[0].type === "scroll" ? scrolls[0].sliceIndex : -1, 8);
  const windows = actions.filter((a) => a.type === "window");
  assert.equal(windows.length, 1);
  assert.equal(windows[0] && windows[0].type === "window" ? windows[0].ww : 0, 1500);
  assert.equal(actions.some((a) => a.type === "zoom"), false);
  const orient = guide.beats.find((b) => b.act === "orient")?.say ?? "";
  const pearl = guide.beats.find((b) => b.act === "pearl")?.say ?? "";
  assert.doesNotMatch(orient, /pleural|pneumothorax/i);
  assert.match(pearl, /pleural/);
  assert.match(pearl, /lung markings/i);
  assert.deepEqual(
    guide.beats.map((b) => b.act),
    ["orient", "search", "commit", "pearl"]
  );
  for (let i = 1; i < guide.beats.length; i++) {
    assert.ok(guide.beats[i].t > guide.beats[i - 1].t);
  }
});

test("word-weighted spans give a long sentence more clock than a short one", () => {
  const spans = spansFromTranscript(
    "Hi. The visceral pleural line at the right apex has no markings beyond it and that is the point.",
    10000
  );
  assert.ok(spans.length >= 2);
  const short = spans[0].tEndMs - spans[0].tStartMs;
  const long = spans[spans.length - 1].tEndMs - spans[spans.length - 1].tStartMs;
  assert.ok(long > short);
  assert.equal(spans[spans.length - 1].tEndMs, 10000);
});

test("early transcript stays on the scroll and the naming line waits for the pearl", () => {
  const guide = buildTeachingGuide(track, {
    narration: [
      { tStartMs: 0, tEndMs: 200, text: "Come down through the apex with me." },
      { tStartMs: 1800, tEndMs: 2400, text: "The visceral pleural line is the finding." },
    ],
    anchors: {
      label: "Right apical pneumothorax",
      description: "Visceral pleural line at the apex.",
    },
  });
  const orient = guide.beats.find((b) => b.act === "orient")?.say ?? "";
  const pearl = guide.beats.find((b) => b.act === "pearl")?.say ?? "";
  assert.match(orient, /Come down through the apex/);
  assert.doesNotMatch(orient, /pleural/i);
  assert.match(pearl, /pleural/i);
});

test("coerceNarrationSpans rejects one blob and keeps ordered estimates", () => {
  const blob = coerceNarrationSpans(
    [
      {
        tStartMs: 0,
        tEndMs: 8000,
        text: "Hi. This longer sentence explains the pleural line in detail.",
      },
    ],
    "Hi. This longer sentence explains the pleural line in detail.",
    8000
  );
  assert.equal(blob.alignment, "proportional");
  assert.ok(blob.spans.length >= 2);
  const estimated = coerceNarrationSpans(
    [
      { tStartMs: 100, tEndMs: 900, text: "Scroll the apex." },
      { tStartMs: 2000, tEndMs: 4000, text: "There is the line." },
    ],
    "Scroll the apex. There is the line.",
    5000
  );
  assert.equal(estimated.alignment, "estimated");
  assert.equal(estimated.spans[1].tStartMs, 2000);
});

test("resolveTeachingGuide speaks stored transcript spans, not only the description", () => {
  const guide = resolveTeachingGuide({
    label: "Effusion",
    description: "Small effusion.",
    teachingPoints: ["Check the costophrenic angle."],
    track: {
      ...track,
      narration: [
        { tStartMs: 0, tEndMs: 400, text: "Start at the apex and scroll." },
        { tStartMs: 2000, tEndMs: 2600, text: "The costophrenic angle is blunted." },
      ],
    },
  });
  assert.ok(guide);
  const said = guide!.beats.map((b) => b.say ?? "").join(" ");
  assert.match(said, /apex/);
  assert.match(said, /costophrenic/i);
  assert.match(said, /Effusion|effusion/);
});
