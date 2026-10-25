import { test } from "node:test";
import assert from "node:assert/strict";
import type { TeachingGuide } from "./types.ts";
import {
  FAR_SLICE_DISTANCE,
  moneySliceFromGuide,
  reseatBeat,
  reseatLine,
  safePlace,
  studentIsFar,
} from "./tourAdapt.ts";

const guide: TeachingGuide = {
  durationMs: 1000,
  start: { sliceIndex: 0 },
  beats: [
    {
      t: 0,
      act: "orient",
      actions: [{ type: "scroll", sliceIndex: 12 }],
    },
    {
      t: 40,
      act: "orient",
      actions: [{ type: "scroll", sliceIndex: 27, seriesInstanceUID: "1.2.3" }],
    },
    { t: 80, act: "pearl", actions: [], say: "Name it." },
  ],
};

test("money slice is the last scroll, including its series", () => {
  assert.deepEqual(moneySliceFromGuide(guide), {
    sliceIndex: 27,
    seriesInstanceUID: "1.2.3",
  });
  assert.equal(moneySliceFromGuide({ ...guide, beats: [] }), null);
});

test("far is strictly beyond 8 slices, apex-low index is too high", () => {
  assert.equal(FAR_SLICE_DISTANCE, 8);
  assert.equal(studentIsFar(19, 27), false);
  assert.equal(studentIsFar(18, 27), true);
  assert.equal(studentIsFar(0, 27), true);
  assert.equal(studentIsFar(undefined, 27), false);
  assert.match(reseatLine(0, 27, "carina"), /too high/);
  assert.match(reseatLine(40, 27, "carina"), /too low/);
});

test("safe place withholds the diagnosis and drops a leading article", () => {
  assert.equal(safePlace("the carina", ["nodule"]), "carina");
  assert.equal(safePlace("spiculated nodule", ["nodule"]), "level we're teaching");
  assert.equal(safePlace("", ["nodule"]), "level we're teaching");
  assert.equal(safePlace("apex", ["PT"]), "apex");
});

test("reseat beat scrolls to the money slice and does not name the finding", () => {
  const beat = reseatBeat({
    currentSlice: 0,
    targetSlice: 27,
    t: 10,
    landmark: "carina",
    withhold: ["nodule"],
    seriesInstanceUID: "1.2.3",
  });
  assert.equal(beat.act, "search");
  assert.match(beat.say ?? "", /carina/);
  assert.doesNotMatch(beat.say ?? "", /nodule/i);
  assert.deepEqual(beat.actions, [
    { type: "scroll", sliceIndex: 27, seriesInstanceUID: "1.2.3" },
  ]);
});
