import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_LABEL,
  arrowLabelConfig,
  cleanLabel,
  describeAnnotation,
  inSeries,
  isEditable,
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
