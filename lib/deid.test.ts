import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deidAllowsPublish,
  evaluateDeid,
  scrubDicomTags,
} from "./deid.ts";

test("scrubDicomTags strips PatientName and InstitutionName", () => {
  const { scrubbed, removed } = scrubDicomTags({
    PatientName: "DOE^JOHN",
    InstitutionName: "City Hospital",
    Modality: "CT",
  });
  assert.equal(scrubbed.PatientName, undefined);
  assert.equal(scrubbed.InstitutionName, undefined);
  assert.equal(scrubbed.Modality, "CT");
  assert.ok(removed.includes("PatientName"));
});

test("evaluateDeid fails when PHI remains", () => {
  const report = evaluateDeid({ PatientID: "MRN123", Modality: "MR" });
  assert.equal(report.status, "fail");
  assert.equal(deidAllowsPublish(report), false);
});

test("evaluateDeid passes a clean tag map", () => {
  const report = evaluateDeid({ Modality: "CT", SeriesDescription: "CTA" });
  assert.equal(report.status, "pass");
  assert.equal(deidAllowsPublish(report), true);
});
