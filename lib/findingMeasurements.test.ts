import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMeasurementBrief,
  normalizeMeasurements,
} from "./findingMeasurements.ts";

test("normalizeMeasurements extracts length mm from Length tool", () => {
  const [m] = normalizeMeasurements([
    {
      handlesPct: [
        [0.2, 0.3],
        [0.4, 0.3],
      ],
      raw: {
        annotationUID: "a1",
        metadata: { toolName: "Length" },
        data: {
          cachedStats: {
            "imageId:1": { length: 12.4, unit: "mm" },
          },
        },
      },
    },
  ]);
  assert.equal(m.kind, "length");
  assert.equal(m.lengthMm, 12.4);
  assert.equal(m.unit, "mm");
  assert.equal(formatMeasurementBrief(m), "length 12.4mm");
});

test("normalizeMeasurements extracts mean HU from EllipticalROI", () => {
  const [m] = normalizeMeasurements([
    {
      handlesPct: [
        [0.4, 0.5],
        [0.5, 0.4],
        [0.3, 0.5],
        [0.5, 0.6],
      ],
      raw: {
        annotationUID: "e1",
        metadata: { toolName: "EllipticalROI" },
        data: {
          cachedStats: {
            "imageId:1": {
              mean: -45,
              max: 10,
              min: -90,
              stdDev: 12,
              area: 80,
              Modality: "CT",
              modalityUnit: "HU",
            },
          },
        },
      },
    },
  ]);
  assert.equal(m.kind, "ellipse");
  assert.equal(m.meanHu, -45);
  assert.equal(m.maxHu, 10);
  assert.match(formatMeasurementBrief(m), /mean -45HU/);
});
