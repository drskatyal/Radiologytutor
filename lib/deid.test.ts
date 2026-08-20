import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertDeidPass,
  deidAllowsPublish,
  DeidFailError,
  evaluateDeid,
  inspectDicomTags,
  isTciaResearchPseudonymId,
  scrubDicomTags,
  type DeidReport,
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
  assert.ok(removed.includes("InstitutionName"));
});

test("scrubDicomTags understands numeric tag forms", () => {
  const { scrubbed, removed } = scrubDicomTags({
    "00100010": "DOE^JANE",
    "00100020": "MRN999",
    Modality: "MR",
  });
  assert.equal(scrubbed["00100010"], undefined);
  assert.equal(scrubbed["00100020"], undefined);
  assert.equal(scrubbed.Modality, "MR");
  assert.ok(removed.includes("00100010"));
});

test("evaluateDeid fails when identity PHI remains", () => {
  const report = inspectDicomTags({ PatientID: "MRN123", Modality: "MR" });
  const verdict = evaluateDeid(report);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.status, "fail");
  assert.equal(deidAllowsPublish(report), false);
  assert.ok(verdict.blocking.some((h) => h.tag === "PatientID"));
});

test("evaluateDeid passes a clean tag map", () => {
  const report = inspectDicomTags({ Modality: "CT", SeriesDescription: "CTA" });
  const verdict = evaluateDeid(report);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.status, "pass");
  assert.equal(deidAllowsPublish(report), true);
});

test("evaluateDeid treats anonymous sentinels as already de-identified", () => {
  const report = inspectDicomTags({
    PatientName: "Anonymous",
    PatientID: "ANON",
    Modality: "CT",
  });
  assert.equal(evaluateDeid(report).pass, true);
});

test("evaluateDeid does not fail on PatientSex or institution name", () => {
  const report = inspectDicomTags({
    PatientSex: "F",
    InstitutionName: "Teaching Archive",
    Modality: "CT",
  });
  assert.equal(evaluateDeid(report).pass, true);
});

test("evaluateDeid honors manual_override", () => {
  const report: DeidReport = {
    headerScrubbed: false,
    pixelOcrScanned: false,
    findings: [{ tag: "PatientName", reason: "reviewer accepted", blocking: true }],
    status: "manual_override",
    inspectedAt: new Date().toISOString(),
  };
  assert.equal(evaluateDeid(report).pass, true);
  assert.equal(deidAllowsPublish(report), true);
});

test("assertDeidPass throws DeidFailError on residual PatientName", () => {
  const report = inspectDicomTags({ PatientName: "DOE^JOHN" });
  assert.throws(() => assertDeidPass(report), DeidFailError);
});

test("pixel OCR is never claimed", () => {
  const report = inspectDicomTags({ Modality: "CT" });
  assert.equal(report.pixelOcrScanned, false);
});

test("TCIA collection pseudonym PatientIDs pass the identity gate", () => {
  assert.equal(isTciaResearchPseudonymId("LIDC-IDRI-0957"), true);
  assert.equal(isTciaResearchPseudonymId("PD-1-Lung-00034"), true);
  assert.equal(isTciaResearchPseudonymId("UPENN-GBM-00544"), true);
  assert.equal(isTciaResearchPseudonymId("MRN123"), false);
  const report = inspectDicomTags({ PatientID: "LIDC-IDRI-0957", Modality: "CT" });
  assert.equal(evaluateDeid(report).pass, true);
  const named = inspectDicomTags({
    PatientName: "PD-1-Lung-00034",
    PatientID: "PD-1-Lung-00034",
    Modality: "CT",
  });
  assert.equal(evaluateDeid(named).pass, true);
});
