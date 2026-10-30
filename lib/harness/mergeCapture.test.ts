import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCaptureDemonstration } from "./mergeCapture.ts";
import { harnessActionFromCall, HARNESS_VIEWER_TOOLS } from "./tools.ts";
import type { RecordedTrack } from "../types.ts";

const track: RecordedTrack = {
  durationMs: 10000,
  start: { sliceIndex: 2, ww: 1500, wc: -600 },
  events: [
    { t: 0, type: "slice", index: 2 },
    { t: 500, type: "cursor", x: 0.4, y: 0.5 },
    { t: 1000, type: "slice", index: 5 },
    { t: 1500, type: "voi", ww: 400, wc: 40 },
    { t: 2000, type: "cursor", x: 0.6, y: 0.55 },
    { t: 3000, type: "series", seriesInstanceUID: "1.2.3.series" },
    { t: 4000, type: "slice", index: 8 },
    { t: 4500, type: "cursor", x: 0.3, y: 0.4 },
  ],
};

test("HARNESS_VIEWER_TOOLS declares viewer drives including the teach script", () => {
  const names = HARNESS_VIEWER_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "clear_overlay",
    "draw_annotation",
    "draw_arrow",
    "draw_circle",
    "jump_to_key_view",
    "next_in_tour",
    "place_card",
    "play_guide",
    "point_to",
    "prev_in_tour",
    "scroll_to",
    "set_invert",
    "set_series",
    "set_window",
    "set_zoom",
    "show_finding",
    "zoom_to",
  ]);
});

test("harnessActionFromCall maps show_finding and set_window", () => {
  assert.deepEqual(
    harnessActionFromCall({ name: "show_finding", args: { findingId: "f1" } }),
    { type: "show_finding", findingId: "f1" }
  );
  assert.equal(
    harnessActionFromCall({
      name: "set_window",
      args: { windowWidth: 400, windowCenter: 40 },
    }).type,
    "set_window"
  );
});

test("mergeCaptureDemonstration aligns speech segments to the track clock", () => {
  const { session, findings } = mergeCaptureDemonstration({
    sessionId: "cap_test",
    parentTrack: track,
    audioUrl: "/api/audio/x",
    transcript: "First nodule. Second effusion.",
    studyInstanceUID: "1.2.3.study",
    seriesInstanceUID: "1.2.3.default",
    segments: [
      {
        label: "Nodule",
        description: "Right upper lobe.",
        teachingPoints: ["Lung window"],
        tStartMs: 0,
        tEndMs: 2500,
      },
      {
        label: "Effusion",
        description: "Small right effusion.",
        teachingPoints: [],
        tStartMs: 2500,
        tEndMs: 5000,
      },
    ],
  });

  assert.equal(session.id, "cap_test");
  assert.equal(session.transcript, "First nodule. Second effusion.");
  assert.equal(findings.length, 2);
  assert.equal(findings[0].label, "Nodule");
  assert.equal(findings[0].captureSessionId, "cap_test");
  assert.ok(findings[0].track);
  assert.ok(findings[0].teachingGuide);
  assert.ok(
    findings[0].teachingGuide!.beats.some((b) =>
      b.actions.some((a) => a.type === "scroll" || a.type === "window" || a.type === "point")
    )
  );
  assert.match(findings[0].teachingGuide!.beats.map((b) => b.say ?? "").join(" "), /nodule|Lung/i);
  assert.equal(findings[0].sliceIndex, 5);
  assert.equal(findings[0].windowWidth, 400);
  assert.ok(findings[0].marker);
  // Second segment sees the series switch at t=3000.
  assert.equal(findings[1].seriesInstanceUID, "1.2.3.series");
  assert.equal(findings[1].sliceIndex, 8);
});
