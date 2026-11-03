// P2.3: measurement math and the annotation store (undo / redo) for native viewports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { engineViewportIds, isNativeHandle, registerHandle, type ViewportHandle } from "./viewer/handles";
import { annotationsHidden, setAnnotationsHidden } from "./native/annotations";
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
  hitAnnotation,
} from "./native/annotations";
import { applySlabChange, slabChangeOf } from "./viewer/slabCommands";
import { wantsBrowserMenu } from "./contextMenuGuard";

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

// HP 0.8.0: engine calls (Esc's cancelActiveManipulations, synchronizers,
// reference lines) must never be given a native viewport.
test("native viewports are told apart from Cornerstone ones and left out of engine ids", () => {
  const el = (native: boolean) => ({ hasAttribute: (n: string) => native && n === "data-native-viewport" }) as unknown as HTMLDivElement;
  const handle = (native: boolean) => ({ element: el(native) }) as unknown as ViewportHandle;
  const offA = registerHandle("a", handle(true));
  const offB = registerHandle("b", handle(false));
  assert.equal(isNativeHandle(handle(true)), true);
  assert.equal(isNativeHandle(handle(false)), false);
  assert.equal(isNativeHandle(undefined), false);
  assert.deepEqual(
    engineViewportIds([
      { key: "a", id: "vp-a" },
      { key: "b", id: "vp-b" },
      { key: "missing", id: "vp-c" },
    ]),
    ["vp-b"]
  );
  offA();
  offB();
});

test("F12 hides native annotations without dropping them", () => {
  setAnnotationsHidden(true);
  assert.equal(annotationsHidden(), true);
  setAnnotationsHidden(false);
  assert.equal(annotationsHidden(), false);
});

test("eraser: a click in the middle of a measurement line hits it (segment distance, px tolerance)", () => {
  // A long Length at 2× zoom: the middle is far from both end points.
  const len: Annotation = { id: "len", tool: "Length", seriesUid: "s", imageIndex: 0, points: [[10, 10], [110, 10]] };
  const toScreen = (p: [number, number]): [number, number] => [p[0] * 2, p[1] * 2];
  assert.equal(hitAnnotation([len], [120, 26], toScreen, 10)?.a.id, "len", "6 px off the middle");
  assert.equal(hitAnnotation([len], [120, 35], toScreen, 10), null, "15 px off: a miss");
  // Ellipse: its drawn outline (inscribed in the drag box), not the box corners.
  const el: Annotation = { id: "el", tool: "EllipticalROI", seriesUid: "s", imageIndex: 0, points: [[0, 0], [100, 50]] };
  const id = (p: [number, number]): [number, number] => p;
  assert.equal(hitAnnotation([el], [100, 25], id, 8)?.a.id, "el", "right edge of the ellipse");
  assert.equal(hitAnnotation([el], [2, 2], id, 8), null, "the box corner is not the ellipse");
  assert.equal(hitAnnotation([el], [50, 25], id, 8), null, "inside: not for selecting");
  assert.equal(hitAnnotation([el], [50, 25], id, 8, { insideCloses: true })?.a.id, "el", "inside: the eraser takes it");
  // Topmost first.
  const top: Annotation = { ...len, id: "top" };
  assert.equal(hitAnnotation([len, top], [120, 20], toScreen, 10)?.a.id, "top");
});

test("slab: a second thickness change registers (10 → 20 mm), modes and steps compose", () => {
  let s = applySlabChange({ mode: "off", mm: 0 }, slabChangeOf("slab-mm:10")!);
  assert.deepEqual(s, { mode: "mip", mm: 10 });
  s = applySlabChange(s, slabChangeOf("slab-mm:20")!);
  assert.deepEqual(s, { mode: "mip", mm: 20 });
  s = applySlabChange(s, slabChangeOf("slab:avg")!);
  assert.deepEqual(s, { mode: "avg", mm: 20 });
  s = applySlabChange(s, { deltaMm: -20 });
  assert.deepEqual(s, { mode: "off", mm: 0 });
  s = applySlabChange(s, { deltaMm: 2 });
  assert.deepEqual(s, { mode: "mip", mm: 2 });
  assert.equal(slabChangeOf("reset"), null);
});

test("context menu guard: the browser menu only in text fields", () => {
  assert.equal(wantsBrowserMenu({ tagName: "DIV" }), false);
  assert.equal(wantsBrowserMenu({ tagName: "CANVAS" }), false);
  assert.equal(wantsBrowserMenu({ tagName: "TEXTAREA" }), true);
  assert.equal(wantsBrowserMenu({ tagName: "INPUT", type: "text" } as never), true);
  assert.equal(wantsBrowserMenu({ tagName: "INPUT", type: "range" } as never), false);
  assert.equal(wantsBrowserMenu({ tagName: "SPAN", isContentEditable: true }), true);
  assert.equal(wantsBrowserMenu(null), false);
});
