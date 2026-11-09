import assert from "node:assert/strict";
import { test } from "node:test";
import { mmPerCssPixel, scaleBarFor, scaleBarLabel } from "@flowrad/viewer-core/scaleBar";

test("scale bar: labels in mm under a centimetre, then whole centimetres", () => {
  assert.equal(scaleBarLabel(5), "5 mm");
  assert.equal(scaleBarLabel(10), "1 cm");
  assert.equal(scaleBarLabel(20), "2 cm");
  assert.equal(scaleBarLabel(500), "50 cm");
  assert.equal(scaleBarLabel(2), "2 mm");
});

test("scale bar: the longest round length within 30 % of the pane, following the zoom", () => {
  // A 350 mm field of view across a 700 px pane: 0.5 mm per pixel; 30 % = 105 mm → 10 cm (200 px).
  assert.deepEqual(scaleBarFor(0.5, 700), { px: 200, mm: 100, label: "10 cm" });
  // Zoomed in 4×: 0.125 mm per pixel; 30 % = 26.25 mm → 2 cm (160 px).
  assert.deepEqual(scaleBarFor(0.125, 700), { px: 160, mm: 20, label: "2 cm" });
  // Way in: 0.01 mm per pixel; 30 % = 2.1 mm → 2 mm (200 px).
  assert.deepEqual(scaleBarFor(0.01, 700), { px: 200, mm: 2, label: "2 mm" });
  // A chest film far out: 2 mm per pixel on a 300 px pane; 30 % = 180 mm → 10 cm (50 px).
  assert.deepEqual(scaleBarFor(2, 300), { px: 50, mm: 100, label: "10 cm" });
});

test("scale bar: none without calibration, a pane, or room", () => {
  assert.equal(scaleBarFor(null, 700), null);
  assert.equal(scaleBarFor(undefined, 700), null);
  assert.equal(scaleBarFor(0, 700), null);
  assert.equal(scaleBarFor(Number.NaN, 700), null);
  assert.equal(scaleBarFor(0.5, 0), null);
  // So far in that not even 1 mm fits in 30 % of the pane.
  assert.equal(scaleBarFor(0.001, 700), null);
  // A tiny pane: 1 cm would be under 24 px.
  assert.equal(scaleBarFor(1, 60), null);
});

test("scale bar: millimetres per CSS pixel from the camera", () => {
  assert.equal(mmPerCssPixel(175, 700), 0.5);
  assert.equal(mmPerCssPixel(0, 700), null);
  assert.equal(mmPerCssPixel(175, 0), null);
  assert.equal(mmPerCssPixel(undefined, 700), null);
});
