import { test } from "node:test";
import assert from "node:assert/strict";
import { remapUid } from "./anonymize.ts";
import { defaultStudyTitle, newStudyRequest, planUpload, type ScannedFile } from "./uploadPlan.ts";

const f = (index: number, series: string, extra: Partial<ScannedFile> = {}): ScannedFile => ({
  index, bytes: 100, studyUid: "1.2.3", seriesUid: series, modality: "CT", ...extra,
});

test("groups by study and series, orders by series number, unticks risky series", () => {
  const plan = planUpload([
    f(0, "1.2.3.2", { seriesNumber: 2 }),
    f(1, "1.2.3.1", { seriesNumber: 1 }),
    f(2, "1.2.3.2", { seriesNumber: 2 }),
    f(3, "1.2.3.9", { modality: "SR", seriesNumber: 900 }),
    f(4, "9.9.1", { studyUid: "9.9", modality: "MR" }),
  ]);
  assert.equal(plan.length, 2);
  const ct = plan[0]!;
  assert.deepEqual(ct.series.map((s) => s.seriesUid), ["1.2.3.1", "1.2.3.2", "1.2.3.9"]);
  assert.deepEqual(ct.series[1]!.fileIndexes, [0, 2]);
  assert.equal(ct.series[2]!.defaultSelected, false);
  assert.match(ct.series[2]!.caution ?? "", /Structured report/);
  assert.deepEqual(ct.modalities, ["CT", "SR"]);
});

test("the create request carries remapped UIDs only, never the originals", () => {
  const [study] = planUpload([f(0, "1.2.3.1"), f(1, "1.2.3.2")]);
  const body = newStudyRequest(study!, new Set(["1.2.3.2"]), "salt", "Chest CT");
  assert.equal(body.studyInstanceUID, remapUid("1.2.3", "salt"));
  assert.deepEqual(body.series.map((s) => s.seriesInstanceUID), [remapUid("1.2.3.2", "salt")]);
  assert.equal(JSON.stringify(body).includes("1.2.3."), false);
  assert.equal(body.bytes, 100);
});

test("default titles", () => {
  assert.equal(defaultStudyTitle({ description: "CHEST W CONTRAST", modalities: ["CT"] }), "CT CHEST W CONTRAST");
  assert.equal(defaultStudyTitle({ description: "CT HEAD", modalities: ["CT"] }), "CT HEAD");
  assert.equal(defaultStudyTitle({ modalities: [] }), "Untitled study");
});
