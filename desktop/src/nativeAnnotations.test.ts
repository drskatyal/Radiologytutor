// P2.3: measurement math and the annotation store (undo / redo) for native viewports.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addAnnotation,
  annotationsFor,
  angleDeg,
  bidirectionalPoints,
  clearAnnotations,
  cobbDeg,
  distanceMm,
  measureText,
  redo,
  removeAnnotations,
  roiShape,
  undo,
  updateAnnotation,
  type Annotation,
} from "./native/annotations";

test("lengths use Pixel Spacing (row, column)", () => {
  // 0.5 mm rows, 2 mm columns: 3 columns + 4 rows → (6, 2) mm.
  assert.equal(distanceMm([0, 0], [3, 4], [0.5, 2]).toFixed(4), Math.hypot(6, 2).toFixed(4));
});

test("angle and Cobb", () => {
  assert.equal(Math.round(angleDeg([[10, 0], [0, 0], [0, 10]], [1, 1])), 90);
  // Two lines 30° apart (either direction) → 30°.
  const c = cobbDeg([[0, 0], [10, 0], [0, 0], [-10 * Math.cos(Math.PI / 6), -10 * Math.sin(Math.PI / 6)]], [1, 1]);
  assert.equal(Math.round(c), 30);
});

test("bidirectional short axis is perpendicular, half the long axis", () => {
  const p = bidirectionalPoints([0, 0], [10, 0]);
  assert.equal(distanceMm(p[2], p[3], [1, 1]).toFixed(3), "5.000");
  assert.equal(p[2][0], 5);
});

test("ROI shapes for Rust (circle from centre + radius)", () => {
  const c: Annotation = { id: "c", tool: "CircleROI", seriesUid: "s", imageIndex: 0, points: [[10, 10], [13, 14]] };
  assert.deepEqual(roiShape(c), { kind: "ellipse", a: [5, 5], b: [15, 15] });
  const st = { mean: 40.04, sd: 3.2, min: 1, max: 80, pixels: 10, areaMm2: 250 };
  assert.match(measureText({ ...c, tool: "EllipticalROI", stats: st }, [1, 1]), /Mean 40\.0 · SD 3\.2 · 2\.50 cm²/);
});

test("store: add, update, remove with undo / redo", () => {
  clearAnnotations();
  const a: Annotation = { id: "a", tool: "Length", seriesUid: "s", imageIndex: 3, points: [[0, 0], [1, 1]] };
  addAnnotation(a);
  updateAnnotation({ ...a, points: [[0, 0], [5, 5]] });
  assert.deepEqual(annotationsFor("s", 3)[0].points[1], [5, 5]);
  assert.equal(removeAnnotations(["a"]), 1);
  assert.equal(annotationsFor("s", 3).length, 0);
  undo(); // remove
  assert.equal(annotationsFor("s", 3).length, 1);
  undo(); // update
  assert.deepEqual(annotationsFor("s", 3)[0].points[1], [1, 1]);
  redo();
  assert.deepEqual(annotationsFor("s", 3)[0].points[1], [5, 5]);
  assert.equal(annotationsFor("s", 2).length, 0);
});
