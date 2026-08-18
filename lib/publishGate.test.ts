import { test } from "node:test";
import assert from "node:assert/strict";
import { deidAllowsPublish, inspectDicomTags } from "./deid.ts";

test("deidAllowsPublish rejects null and failed reports", () => {
  assert.equal(deidAllowsPublish(null), false);
  assert.equal(deidAllowsPublish(undefined), false);
  assert.equal(deidAllowsPublish(inspectDicomTags({ PatientID: "MRN" })), false);
});

test("passing header report is enough to allow publish (OCR not required)", () => {
  const report = inspectDicomTags({ Modality: "CT", SeriesDescription: "Axial" });
  assert.equal(report.pixelOcrScanned, false);
  assert.equal(deidAllowsPublish(report), true);
});
