import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearTeachVoi,
  initialTeachVoi,
  requestTeachVoi,
  settleTeachVoi,
  voiNear,
  voiToWwWc,
  voiWriteSteps,
  wwWcToVoi,
  type TeachVoiState,
} from "./viewportVoi.ts";

const SOFT = { ww: 400, wc: 40 };
const LUNG = { ww: 1500, wc: -600 };

/**
 * LIDC finding 1. The guide starts on the DICOM soft-tissue window, the
 * search beat asks for lung windows, and slice loads / compare resize try
 * to put W 400 / L 40 back. The viewport must still read lung.
 */
function lidcSearch(): TeachVoiState {
  let state = initialTeachVoi(SOFT);
  state = requestTeachVoi(state, SOFT.ww, SOFT.wc);
  state = settleTeachVoi(state, SOFT);
  state = requestTeachVoi(state, LUNG.ww, LUNG.wc);
  state = settleTeachVoi(state, SOFT);
  state = settleTeachVoi(state, SOFT);
  state = requestTeachVoi(state, LUNG.ww, LUNG.wc);
  state = settleTeachVoi(state, SOFT);
  return settleTeachVoi(state, SOFT);
}

test("a guide lung window survives the slice load that restores W 400 / L 40", () => {
  const state = lidcSearch();
  assert.equal(state.ww, 1500);
  assert.equal(state.wc, -600);
  assert.ok(voiNear({ ww: state.ww ?? 0, wc: state.wc ?? 0 }, LUNG));
});

test("compare resize cannot paint the soft-tissue snapshot over the teach window", () => {
  let state = requestTeachVoi(initialTeachVoi(SOFT), LUNG.ww, LUNG.wc);
  state = settleTeachVoi(state, SOFT);
  assert.equal(state.ww, 1500);
  assert.equal(state.wc, -600);
});

test("reset drops the teach window so the image default can show again", () => {
  const taught = requestTeachVoi(initialTeachVoi(SOFT), LUNG.ww, LUNG.wc);
  const reset = clearTeachVoi(taught, SOFT);
  const settled = settleTeachVoi(reset, SOFT);
  assert.equal(settled.requested, null);
  assert.equal(settled.ww, 400);
  assert.equal(settled.wc, 40);
});

test("an equal soft-tissue write still locks, so the next slice cannot skip it", () => {
  const current = wwWcToVoi(400, 40);
  const steps = voiWriteSteps(current, 400, 40, { locked: false });
  assert.equal(steps.length, 2);
  assert.notDeepEqual(steps[0], current);
  assert.deepEqual(steps[1], current);

  const lung = voiWriteSteps(current, 1500, -600, { locked: false });
  assert.deepEqual(lung, [wwWcToVoi(1500, -600)]);

  const held = voiWriteSteps(wwWcToVoi(1500, -600), 1500, -600, { locked: true });
  assert.deepEqual(held, []);
});

test("readout rounding still counts as the authored lung window", () => {
  assert.equal(voiNear({ ww: 1500.4, wc: -599.6 }, LUNG), true);
  assert.equal(voiNear(SOFT, LUNG), false);
});

test("window ↔ range follows the DICOM linear function, as Cornerstone does for the file's window", () => {
  // Cornerstone's toLowHighRange(400, 40): the range a CT file's W 400 / L 40 opens with.
  assert.deepEqual(wwWcToVoi(400, 40), { lower: -160, upper: 239 });
  assert.deepEqual(voiToWwWc({ lower: -160, upper: 239 }), { ww: 400, wc: 40 }, "reads 400 / 40, not 399 / 39.5");
  for (const [ww, wc] of [[1500, -600], [2500, 480], [80, 35], [350, 50], [2.5, 0.5]]) {
    assert.deepEqual(voiToWwWc(wwWcToVoi(ww, wc)), { ww, wc }, `${ww} / ${wc} round-trips`);
  }
  // Width 1 (a threshold) keeps a positive range and still reads width ~1.
  const one = wwWcToVoi(1, 100);
  assert.ok(one.upper > one.lower);
  assert.ok(Math.abs(voiToWwWc(one)!.ww - 1) < 0.01);
  assert.equal(voiToWwWc({ lower: 5, upper: 5 }), null);
  assert.equal(voiToWwWc(null), null);
});
