import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessActionFromCall } from "./harness/tools.ts";
import { applyActions, type SimViewer } from "./harness/tutorEval.ts";
import {
  authoredSeriesAllowlist,
  parseSeriesCatalog,
  parseSetSeriesArgs,
  promptSeriesCatalog,
  sanitizeSeriesActions,
} from "./setSeries.ts";
import type { Finding } from "./types.ts";

const finding = {
  id: "f1",
  label: "FLAIR hyperintensity",
  description: "Left frontal.",
  teachingPoints: [],
  state: " ",
  marker: { x_pct: 0.4, y_pct: 0.4, shape: "circle" as const },
  order: 0,
  seriesInstanceUID: "1.2.840.t2",
  anchors: [
    { seriesInstanceUID: "1.2.840.t2", marker: { x_pct: 0.4, y_pct: 0.4, shape: "circle" as const } },
    { seriesInstanceUID: "1.2.840.flair", marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" as const } },
  ],
  drive: { seriesInstanceUID: "1.2.840.t1" },
  compare: { seriesInstanceUID: "1.2.840.prior" },
} as Finding & {
  drive: { seriesInstanceUID: string };
  compare: { seriesInstanceUID: string };
};

test("authoredSeriesAllowlist keeps rail, anchors, and LiveTeachingPack drive/compare", () => {
  const allow = authoredSeriesAllowlist({
    series: [{ seriesInstanceUID: "1.2.840.dwi" }],
    studyRefs: [{ seriesInstanceUIDs: ["1.2.840.t1"] }],
    findings: [finding],
    pack: {
      authoredSeriesInstanceUIDs: ["1.2.840.authored"],
      findings: [{ seriesInstanceUID: "1.2.840.pack" }],
      compare: { seriesInstanceUID: "1.2.840.pack-compare" },
    },
  });
  for (const uid of [
    "1.2.840.dwi",
    "1.2.840.t1",
    "1.2.840.t2",
    "1.2.840.flair",
    "1.2.840.prior",
    "1.2.840.pack",
    "1.2.840.pack-compare",
    "1.2.840.authored",
  ]) {
    assert.equal(allow.has(uid), true, uid);
  }
  assert.equal(allow.has("1.2.840.invented"), false);
});

test("parseSetSeriesArgs keeps slice and window and drops a negative slice", () => {
  assert.deepEqual(
    parseSetSeriesArgs({
      seriesInstanceUID: " 1.2.840.flair ",
      sliceIndex: 12.2,
      ww: 400,
      wc: 40,
    }),
    { type: "set_series", seriesInstanceUID: "1.2.840.flair", sliceIndex: 12, ww: 400, wc: 40 }
  );
  assert.deepEqual(parseSetSeriesArgs({ seriesInstanceUID: "1.2.840.flair", sliceIndex: -3, ww: 1 }), {
    type: "set_series",
    seriesInstanceUID: "1.2.840.flair",
  });
  assert.equal(parseSetSeriesArgs({ seriesInstanceUID: " " }), null);
});

test("harnessActionFromCall maps set_series and rejects an empty uid", () => {
  assert.deepEqual(
    harnessActionFromCall({
      name: "set_series",
      args: { seriesInstanceUID: "1.2.840.t2", sliceIndex: 4, ww: 200, wc: 80 },
    }),
    { type: "set_series", seriesInstanceUID: "1.2.840.t2", sliceIndex: 4, ww: 200, wc: 80 }
  );
  assert.deepEqual(harnessActionFromCall({ name: "set_series", args: {} }), { type: "none" });
});

test("sanitizeSeriesActions drops invented series and keeps an authored switch", () => {
  const allow = new Set(["1.2.840.flair"]);
  const kept = sanitizeSeriesActions(
    [
      { type: "set_series", seriesInstanceUID: "1.2.840.flair", sliceIndex: 3 },
      { type: "set_series", seriesInstanceUID: "1.2.999.nope" },
      { type: "scroll_to", sliceIndex: 8, seriesInstanceUID: "1.2.999.nope" },
      { type: "scroll_to", sliceIndex: 2 },
      { type: "show_finding", findingId: "f1" },
    ],
    allow
  );
  assert.deepEqual(kept, [
    { type: "set_series", seriesInstanceUID: "1.2.840.flair", sliceIndex: 3 },
    { type: "scroll_to", sliceIndex: 2 },
    { type: "show_finding", findingId: "f1" },
  ]);
});

test("prompt catalog prefers the loaded rail and ignores a client UID that is not allowed", () => {
  const client = parseSeriesCatalog([
    { seriesInstanceUID: "1.2.840.t2", description: "Ax T2", modality: "MR", instanceCount: 24 },
    { seriesInstanceUID: "not a uid" },
    { seriesInstanceUID: "1.2.840.invented", description: "Fake" },
  ]);
  assert.equal(client.length, 2);
  const allow = new Set(["1.2.840.t2"]);
  const prompt = promptSeriesCatalog(client, allow);
  assert.deepEqual(prompt, [
    { seriesInstanceUID: "1.2.840.t2", description: "Ax T2", modality: "MR", instanceCount: 24 },
  ]);
});

test("applyActions moves only to an authored series", () => {
  const start: SimViewer = {
    sliceIndex: 1,
    windowWidth: 1500,
    windowCenter: -600,
    zoom: 1,
    pointer: null,
    activeFindingId: "f1",
    seriesInstanceUID: "1.2.840.t2",
  };
  const moved = applyActions(
    start,
    [{ type: "set_series", seriesInstanceUID: "1.2.840.flair", sliceIndex: 9, ww: 80, wc: 40 }],
    [finding]
  );
  assert.equal(moved.viewer.seriesInstanceUID, "1.2.840.flair");
  assert.equal(moved.viewer.sliceIndex, 9);
  assert.equal(moved.viewer.windowWidth, 80);
  assert.equal(moved.viewer.windowCenter, 40);
  assert.ok(moved.effects.some((effect) => effect.type === "series" && effect.source === "set_series"));

  const rejected = applyActions(
    start,
    [{ type: "set_series", seriesInstanceUID: "1.2.999.nope", sliceIndex: 4 }],
    [finding]
  );
  assert.equal(rejected.viewer.seriesInstanceUID, "1.2.840.t2");
  assert.equal(rejected.viewer.sliceIndex, 1);
  assert.equal(rejected.effects.length, 0);
});
