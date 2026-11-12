import { test } from "node:test";
import assert from "node:assert/strict";
import {
  caseDeclaresRealStudy,
  selectLearnerStudy,
  teacherCanTestAsStudent,
} from "./learnerEntry.ts";

test("learner entry prefers a published real study over the bundled sample", () => {
  const picked = selectLearnerStudy([
    {
      caseId: "bundled",
      status: "published",
      updatedAt: "2026-10-01",
      studyRefs: [{ studyInstanceUID: "flowrad.bundled.study" }],
    },
    {
      caseId: "draft-ct",
      status: "draft",
      updatedAt: "2026-10-20",
      authorId: "auth_real",
      studyRefs: [{ studyInstanceUID: "1.2.3" }],
    },
    {
      caseId: "older",
      status: "published",
      updatedAt: "2026-09-01",
      authorId: "auth_real",
      studyRefs: [{ studyInstanceUID: "1.2.3" }],
    },
    {
      caseId: "newer",
      status: "published",
      updatedAt: "2026-10-02",
      authorId: "auth_real",
      findings: [{ studyInstanceUID: "1.2.9" }],
    },
  ]);
  assert.equal(picked?.caseId, "newer");
  assert.equal(caseDeclaresRealStudy({ caseId: "bundled", studyRefs: [{ studyInstanceUID: "flowrad.bundled.study" }] }), false);
});

test("a placeholder-author study is the entry when it is the only real study", () => {
  const picked = selectLearnerStudy([
    {
      caseId: "case-lidc-nodule-search",
      status: "published",
      authorId: "auth_demo",
      updatedAt: "2026-01-01",
      studyRefs: [{ studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.210460865401632134346677582159" }],
    },
  ]);
  assert.equal(picked?.caseId, "case-lidc-nodule-search");
});

test("Test as student waits until a finding has been saved", () => {
  assert.equal(teacherCanTestAsStudent(0), false);
  assert.equal(teacherCanTestAsStudent(1), true);
});
