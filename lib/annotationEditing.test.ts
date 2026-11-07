import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_LABEL,
  arrowLabelConfig,
  cleanLabel,
  describeAnnotation,
  inSeries,
  isEditable,
  needsFreehandStats,
  labelEditorPosition,
  onImage,
  type AnnotationLike,
} from "../packages/viewer-core/src/annotationEditing.ts";

const ann = (tool: string, imageId: string, extra: Partial<AnnotationLike["data"]> = {}): AnnotationLike => ({
  annotationUID: `${tool}-${imageId}`,
  metadata: { toolName: tool, referencedImageId: imageId },
  data: { handles: { points: [[0, 0, 0], [1, 1, 0]] }, ...extra },
});

test("arrow draws without a prompt: the label is a placeholder, cleaned to empty", () => {
  let label: string | null = null;
  arrowLabelConfig(() => undefined).getTextCallback((t) => (label = t));
  assert.equal(label, PENDING_LABEL, "never empty (Cornerstone deletes an arrow with an empty new label)");
  assert.equal(cleanLabel(label!), "");
  assert.equal(cleanLabel("Nodule"), "Nodule");
});

test("double-click asks the inline editor with the current label and position", () => {
  const seen: unknown[] = [];
  const el = {} as HTMLElement;
  arrowLabelConfig((req) => seen.push(req)).changeTextCallback(
    ann("ArrowAnnotate", "a", { label: `${PENDING_LABEL}` }),
    { element: el, currentPoints: { canvas: [12, 34] } },
    () => undefined
  );
  assert.equal(seen.length, 1);
  const req = seen[0] as { at: { x: number; y: number }; current: string; element: HTMLElement };
  assert.deepEqual(req.at, { x: 12, y: 34 });
  assert.equal(req.current, "");
  assert.equal(req.element, el);
});

test("on this image / in this series: only editable annotations of those images", () => {
  const all = [ann("Length", "i1"), ann("ArrowAnnotate", "i1"), ann("Length", "i2"), ann("Length", "other"), ann("Crosshairs", "i1")];
  assert.equal(onImage(all, "i1").length, 2);
  assert.equal(onImage(all, undefined).length, 0);
  assert.equal(inSeries(all, ["i1", "i2"]).length, 3);
  assert.equal(isEditable(ann("Crosshairs", "i1")), false);
});

test("copy value: measurement text with units", () => {
  assert.equal(describeAnnotation(ann("Length", "i", { cachedStats: { "img:1": { length: 23.44, unit: "mm" } } })), "Length 23.4 mm");
  assert.equal(
    describeAnnotation(ann("EllipticalROI", "i", { cachedStats: { x: { mean: 41.23, stdDev: 9.81, max: 120, area: 120.5, modalityUnit: "HU", areaUnit: "mm²" } } })),
    "Mean 41.2 HU · SD 9.8 · Max 120.0 · Area 120.5 mm²"
  );
  assert.equal(describeAnnotation(ann("Angle", "i", { cachedStats: { x: { angle: 34.56 } } })), "Angle 34.6°");
  assert.equal(describeAnnotation(ann("ArrowAnnotate", "i", { label: "Lesion" })), "Lesion");
  assert.equal(describeAnnotation(ann("ArrowAnnotate", "i")), "Arrow Annotate");
});

test("a closed freehand ROI with no stats is flagged for a stats pass; others are left alone", () => {
  const freehand = (closed: boolean, cachedStats?: Record<string, Record<string, unknown>>) => ({
    metadata: { toolName: "PlanarFreehandROI", referencedImageId: "i1" },
    data: { contour: { closed }, cachedStats },
  });
  assert.equal(needsFreehandStats(freehand(true, {})), true);
  assert.equal(needsFreehandStats(freehand(true)), true);
  assert.equal(needsFreehandStats(freehand(true, { "imageId:i1": { area: 12 } })), false);
  assert.equal(needsFreehandStats(freehand(false, {})), false, "an open contour has no area");
  assert.equal(needsFreehandStats({ metadata: { toolName: "CircleROI" }, data: { cachedStats: {} } }), false);
});

test("inline label field: where the label goes, clear of the arrow, on screen", () => {
  const size = { width: 208, height: 46 };
  const bounds = { width: 1190, height: 825 };
  const inside = (p: { left: number; top: number }) =>
    p.left >= 0 && p.top >= 0 && p.left + size.width <= bounds.width && p.top + size.height <= bounds.height;
  // The e2e arrow: head up-left, tail at the centre. The field used to sit on the
  // arrowhead with the line running through its hint; now it is right of the
  // arrow's rightmost point, centred on it (Cornerstone's label spot).
  const head: [number, number] = [118, 82];
  const tail: [number, number] = [597, 412];
  const p = labelEditorPosition([head, tail], size, bounds);
  assert.ok(inside(p), JSON.stringify(p));
  assert.ok(p.left > tail[0], `right of the arrow: ${JSON.stringify(p)}`);
  assert.ok(Math.abs(p.top + size.height / 2 - (head[1] + tail[1]) / 2) <= 1, "centred on the arrow");
  // Near the right edge: the left side instead, still clear of the line.
  const q = labelEditorPosition([[900, 300], [1150, 500]], size, bounds);
  assert.ok(inside(q));
  assert.ok(q.left + size.width < 900, JSON.stringify(q));
  // A long arrow across the whole width: above or below it, never on it.
  const r = labelEditorPosition([[10, 400], [1180, 410]], size, bounds);
  assert.ok(inside(r));
  assert.ok(r.top + size.height < 400 || r.top > 410, JSON.stringify(r));
  // A label the reader moved: its own spot.
  assert.deepEqual(labelEditorPosition([head, tail], size, bounds, [700, 100]), { left: 700, top: 77 });
  // Off-screen anchors are pulled back on screen.
  assert.ok(inside(labelEditorPosition([[-50, -50]], size, bounds)));
  assert.ok(inside(labelEditorPosition([[1180, 820], [1185, 822]], size, bounds)));
});
