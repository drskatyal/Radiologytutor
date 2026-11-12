import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "../../fixtures/synthetic/case.json";
import type { CaseData } from "../types";
import { learnerCaseProjection, examInitialView, type LearnerSafeCase } from "./projection";
const data = fixture as CaseData;
test("exam projection contains no answer canaries, labels, geometry, packs or opening hints", () => {
  const safe = learnerCaseProjection(data);
  assert.equal(safe.findingCount, 2);
  assert.deepEqual(safe.findingOrder, [1, 2]);
  assert.equal(examInitialView.openSlice(), null);
  assert.doesNotMatch(JSON.stringify(safe), /CANARY|sliceIndex|sopInstanceUID|marker|rubric|teachingPoints|liveTeachingPack/);
  assert.deepEqual(Object.keys(safe).sort(), ["caseId", "title", "modality", "stem", "studyRefs", "findingCount", "findingOrder"].sort());
  // @ts-expect-error Raw case data cannot satisfy exam component props.
  const unsafe: LearnerSafeCase = data;
  void unsafe;
});
