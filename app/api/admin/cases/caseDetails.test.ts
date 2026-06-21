import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asPatientSex,
  asTargetLevel,
  cleanStr,
  cleanStrList,
  coerceCaseDetails,
  pickPresentDetails,
} from "./caseDetails.ts";

test("cleanStr trims and collapses blanks to undefined", () => {
  assert.equal(cleanStr("  hello "), "hello");
  assert.equal(cleanStr("   "), undefined);
  assert.equal(cleanStr(""), undefined);
  assert.equal(cleanStr(42), undefined);
  assert.equal(cleanStr(undefined), undefined);
});

test("cleanStrList trims, drops blanks, and empties to undefined", () => {
  assert.deepEqual(cleanStrList([" a ", "", "b", "   "]), ["a", "b"]);
  assert.equal(cleanStrList([]), undefined);
  assert.equal(cleanStrList(["", "  "]), undefined);
  assert.equal(cleanStrList("not an array"), undefined);
});

test("asPatientSex only accepts canonical values", () => {
  assert.equal(asPatientSex("M"), "M");
  assert.equal(asPatientSex("F"), "F");
  assert.equal(asPatientSex("other"), "other");
  assert.equal(asPatientSex("unknown"), "unknown");
  assert.equal(asPatientSex("male"), undefined);
  assert.equal(asPatientSex(""), undefined);
});

test("asTargetLevel only accepts canonical tiers", () => {
  assert.equal(asTargetLevel("R1"), "R1");
  assert.equal(asTargetLevel("registrar"), "registrar");
  assert.equal(asTargetLevel("fellow"), "fellow");
  assert.equal(asTargetLevel("CME"), "CME");
  assert.equal(asTargetLevel("attending"), undefined);
  assert.equal(asTargetLevel(undefined), undefined);
});

test("coerceCaseDetails validates + cleans the whole detail block", () => {
  const out = coerceCaseDetails({
    clinicalHistory: "  24M RIF pain ",
    patientAge: " 24 ",
    patientSex: "M",
    technique: "",
    primaryDiagnosis: "Appendicitis",
    differentials: [" Mesenteric adenitis ", ""],
    targetLevel: "bogus",
    learningObjectives: ["Recognise secondary signs"],
    discussion: "   ",
    references: [],
  });
  assert.deepEqual(out, {
    clinicalHistory: "24M RIF pain",
    patientAge: "24",
    patientSex: "M",
    technique: undefined,
    primaryDiagnosis: "Appendicitis",
    differentials: ["Mesenteric adenitis"],
    targetLevel: undefined, // invalid enum dropped, not thrown
    learningObjectives: ["Recognise secondary signs"],
    discussion: undefined,
    references: undefined,
  });
});

test("pickPresentDetails only includes keys present in the body", () => {
  // Only primaryDiagnosis present → only that key (cleared/blank semantics apply
  // to present keys only; omitted keys are untouched by the caller).
  const patch = pickPresentDetails({ primaryDiagnosis: " Appendicitis " });
  assert.deepEqual(Object.keys(patch), ["primaryDiagnosis"]);
  assert.equal(patch.primaryDiagnosis, "Appendicitis");

  // A present-but-blank field clears (undefined) — the "remove this" semantics.
  const cleared = pickPresentDetails({ discussion: "   " });
  assert.deepEqual(Object.keys(cleared), ["discussion"]);
  assert.equal(cleared.discussion, undefined);

  // Empty body → empty patch (nothing touched).
  assert.deepEqual(pickPresentDetails({}), {});
});
