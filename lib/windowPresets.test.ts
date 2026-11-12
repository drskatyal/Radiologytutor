import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_PRESETS,
  FULL_DYNAMIC_ID,
  presetsForModality,
  matchPreset,
  parseCustomWindow,
} from "./windowPresets.ts";

test("ships the canonical CT presets with correct ww/wc", () => {
  const byId = new Map(WINDOW_PRESETS.map((p) => [p.id, p]));
  assert.deepEqual(
    [byId.get("ct-brain")?.ww, byId.get("ct-brain")?.wc],
    [80, 40]
  );
  assert.deepEqual([byId.get("ct-bone")?.ww, byId.get("ct-bone")?.wc], [2500, 480]);
  assert.deepEqual([byId.get("ct-lung")?.ww, byId.get("ct-lung")?.wc], [1500, -600]);
  assert.deepEqual([byId.get("ct-angio")?.ww, byId.get("ct-angio")?.wc], [600, 300]);
});

test("presetsForModality returns CT presets for CT, case-insensitive", () => {
  const ct = presetsForModality("ct");
  assert.ok(ct.length > 0);
  assert.ok(ct.every((p) => p.modalities.includes("CT") || p.modalities.includes("*")));
});

test("presetsForModality never returns an empty list", () => {
  assert.ok(presetsForModality("").length > 0);
  assert.ok(presetsForModality("MR").length > 0); // falls back to the shipped set
  assert.ok(presetsForModality(undefined).length > 0);
});

test("matchPreset identifies a preset within tolerance", () => {
  assert.equal(matchPreset(80, 40), "ct-brain");
  assert.equal(matchPreset(80.5, 39.7), "ct-brain"); // within ±1
  assert.equal(matchPreset(123, 456), null);
});

test("FULL_DYNAMIC_ID is distinct from any real preset id", () => {
  assert.ok(!WINDOW_PRESETS.some((p) => p.id === FULL_DYNAMIC_ID));
});

test("Set window: typed width / level, validated", () => {
  assert.deepEqual(parseCustomWindow("400", "40"), { ww: 400, wc: 40 });
  assert.deepEqual(parseCustomWindow(" 1500 ", "-600"), { ww: 1500, wc: -600 }, "lung: negative level");
  assert.deepEqual(parseCustomWindow("2,5", "0.5"), { ww: 2.5, wc: 0.5 }, "a decimal comma");
  assert.deepEqual(parseCustomWindow("1", "0"), { ww: 1, wc: 0 }, "width 1 is the minimum");
  assert.equal(parseCustomWindow("0.5", "40"), null, "width under 1");
  assert.equal(parseCustomWindow("-400", "40"), null);
  assert.equal(parseCustomWindow("", "40"), null);
  assert.equal(parseCustomWindow("400", ""), null);
  assert.equal(parseCustomWindow("4e2", "40"), null, "no exponent notation");
  assert.equal(parseCustomWindow("400abc", "40"), null);
  assert.equal(parseCustomWindow("400", "NaN"), null);
});
