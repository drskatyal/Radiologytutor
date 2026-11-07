import { test } from "node:test";
import assert from "node:assert/strict";
import {
  measurementReportText,
  measurementRows,
  measurementValue,
  type AnnotationLike,
} from "../packages/viewer-core/src/measurementReport.ts";

const ann = (tool: string, stats: Record<string, unknown> | null, extra: Partial<AnnotationLike["data"]> = {}, imageId = "dicomfile:1", uid = tool): AnnotationLike => ({
  annotationUID: uid,
  metadata: { toolName: tool, referencedImageId: imageId },
  data: { ...extra, cachedStats: stats ? { "imageId:x": stats } : {} },
});

test("values: each tool's own numbers, rounded for reading", () => {
  assert.equal(measurementValue(ann("Length", { length: 23.4567, unit: "mm" })), "23.5 mm");
  assert.equal(measurementValue(ann("Angle", { angle: 89.96 })), "90.0°");
  assert.equal(measurementValue(ann("CobbAngle", { angle: 12.34 })), "12.3°");
  assert.equal(measurementValue(ann("Bidirectional", { length: 31.2, width: 18.04, unit: "mm" })), "31.2 × 18.0 mm");
  assert.equal(
    measurementValue(ann("EllipticalROI", { mean: 42.12, stdDev: 8.04, area: 320.4, areaUnit: "mm²", modalityUnit: "HU" })),
    "Mean 42.1 HU · SD 8.0 · Area 3.20 cm²"
  );
  assert.equal(measurementValue(ann("CircleROI", { mean: -850, stdDev: 20, area: 6.5, areaUnit: "mm²", modalityUnit: "HU" })), "Mean -850.0 HU · SD 20.0 · Area 6.50 mm²");
  assert.equal(measurementValue(ann("Probe", { value: 61.9, modalityUnit: "HU" })), "61.9 HU");
  assert.equal(measurementValue(ann("ArrowAnnotate", null, { text: " nodule " })), "“nodule”");
  assert.equal(measurementValue(ann("ArrowAnnotate", null)), "(no text)");
});

test("stats not ready yet: listed as measuring…, never invented", () => {
  assert.equal(measurementValue(ann("Length", null)), null);
  assert.equal(measurementValue(ann("PlanarFreehandROI", {})), null);
  const rows = measurementRows([ann("Length", null)], () => null);
  assert.equal(rows[0]!.value, "measuring…");
});

test("rows: listed tools only, sorted by series, image, then order made", () => {
  const places: Record<string, { series: string; image: number }> = {
    a: { series: "CT Se 2", image: 31 },
    b: { series: "CT Se 2", image: 4 },
    c: { series: "CT Se 10", image: 1 },
  };
  const rows = measurementRows(
    [
      ann("Length", { length: 10, unit: "mm" }, {}, "a", "u1"),
      ann("Crosshairs", { length: 1 }, {}, "a", "u2"),
      ann("Angle", { angle: 30 }, { label: "Cobb-like" }, "c", "u3"),
      ann("Probe", { value: 5, modalityUnit: "HU" }, {}, "b", "u4"),
      ann("Length", { length: 20, unit: "mm" }, {}, "a", "u5"),
    ],
    (id) => places[id] ?? null
  );
  assert.deepEqual(rows.map((r) => r.uid), ["u4", "u1", "u5", "u3"]);
  assert.equal(rows[3]!.label, "Cobb-like");
});

test("report text: numbered, label first, place without patient details", () => {
  const text = measurementReportText([
    { uid: "1", imageId: "a", kind: "Length", value: "23.4 mm", place: { series: "CT Se 2", image: 31 } },
    { uid: "2", imageId: "b", kind: "Ellipse ROI", value: "Mean 40.0 HU", label: "Liver" },
  ]);
  assert.equal(text, "1. Length 23.4 mm — CT Se 2, Im 31\n2. Liver (ellipse roi) Mean 40.0 HU");
});
