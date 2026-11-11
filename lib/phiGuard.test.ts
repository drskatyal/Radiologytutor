import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertNoPhi, assertReviewedMedia, exportSafeMetadata, PhiError } from "./phiGuard";
import { structureAnswer } from "./exam/structureAnswer";
import { anonymousLines } from "./viewerExport";

test("synthetic metadata passes; dirty metadata and named identity families fail closed", () => {
  const clean = JSON.parse(readFileSync("fixtures/synthetic/study.json", "utf8"));
  const dirty = JSON.parse(readFileSync("fixtures/synthetic/dirty-metadata.json", "utf8"));
  assert.doesNotThrow(() => assertNoPhi(clean));
  assert.throws(() => assertNoPhi(dirty), PhiError);
  for (const key of ["PatientName", "PatientID", "PatientBirthDate", "AccessionNumber", "ReferringPhysicianName"]) assert.throws(() => assertNoPhi({ nested: { [key]: "SYNTHETIC-DIRTY-TEST" } }), PhiError);
  assert.deepEqual(exportSafeMetadata({ PatientName: "SYNTHETIC^TEST", PatientID: "SYN-0001", StudyInstanceUID: "1.2", custom: "discard" }), { StudyInstanceUID: "1.2" });
  assert.throws(() => exportSafeMetadata({ PatientID: "ACC12345" }), PhiError);
});
test("media review covers pixels, audio and screen independently", () => {
  for (const field of ["pixels", "audio", "screen"]) assert.throws(() => assertReviewedMedia({ pixels: true, audio: true, screen: true, [field]: false }), PhiError);
  assert.doesNotThrow(() => assertReviewedMedia({ pixels: true, audio: true, screen: true }));
  for (const value of ["false", "true", 1, null]) assert.throws(() => assertReviewedMedia({ pixels: value, audio: true, screen: true } as never), PhiError);
});
test("spoken/text identifiers cannot reach the exam structuring model or export overlays", async () => {
  let calls = 0;
  await assert.rejects(structureAnswer("Patient ID: ACC12345", async () => { calls++; return { text: "{}" }; }), PhiError);
  assert.equal(calls, 0);
  assert.throws(() => anonymousLines({ modality: "DOE^JANE", index: 0, count: 1 }), PhiError);
});
