import assert from "node:assert/strict";
import { test } from "node:test";
import { curvedMpr, curvedMprToRgba, polylineLength, resamplePolyline, type Point3 } from "../packages/viewer-core/src/curvedMpr";

test("resample a polyline at even arc-length steps", () => {
  const pts = resamplePolyline([[0, 0, 0], [10, 0, 0], [10, 10, 0]], 2);
  assert.equal(pts.length, 11); // 0,2,...,20 mm along the L
  assert.deepEqual(pts[5], [10, 0, 0]);
  assert.deepEqual(pts[10], [10, 10, 0]);
  assert.equal(polylineLength([[0, 0, 0], [3, 4, 0]]), 5);
});

test("a curved tube straightens into a horizontal band", () => {
  // A bright tube following a quarter circle of radius 50 in the axial plane, at every z.
  const center: Point3 = [0, 0, 0];
  const sample = ([x, y]: Point3) => (Math.abs(Math.hypot(x - center[0], y - center[1]) - 50) < 2 ? 1000 : 0);
  const arc: Point3[] = Array.from({ length: 20 }, (_, i) => {
    const a = (i / 19) * (Math.PI / 2);
    return [50 * Math.cos(a), 50 * Math.sin(a), 0];
  });
  // Drawn on an axial plane: the output's vertical axis is z, and the tube is
  // along the curve, so every pixel of the straightened image is inside it.
  const img = curvedMpr({ points: arc, normal: [0, 0, 1], halfHeightMm: 10, stepMm: 1, sample });
  assert.ok(Math.abs(img.lengthMm - (Math.PI / 2) * 50) < 0.5);
  assert.equal(img.height, 21);
  const bright = Array.from(img.values).filter((v) => v === 1000).length;
  assert.ok(bright / img.values.length > 0.95, `${bright} of ${img.values.length} on the vessel`);
});

test("vertical axis follows the normal; outside the volume is NaN; windowing to RGBA", () => {
  const sample = ([, , z]: Point3) => (Math.abs(z) > 5 ? Number.NaN : z);
  const img = curvedMpr({ points: [[0, 0, 0], [4, 0, 0]], normal: [0, 0, 2], halfHeightMm: 8, stepMm: 1, sample });
  assert.ok(Number.isNaN(img.values[0]));
  assert.equal(img.values[8 * img.width], 0); // middle row z=0
  assert.equal(img.values[5 * img.width], 3); // z=+3
  const rgba = curvedMprToRgba(img, 10, 0);
  assert.equal(rgba[0], 0);
  assert.equal(rgba[8 * img.width * 4], 128);
});
