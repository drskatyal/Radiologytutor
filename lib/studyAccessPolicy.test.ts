import { test } from "node:test";
import assert from "node:assert/strict";
import { studyReadAllowed } from "./studyAccessPolicy";

const published = new Set(["1.2.3"]);

test("authors read any study their org registered, draft or not", () => {
  assert.equal(
    studyReadAllowed({ canAuthor: true, orgOwnsStudy: true, publishedStudyUids: published, studyUid: "9.9" }),
    true
  );
});

test("learners read only studies that a published case names", () => {
  assert.equal(
    studyReadAllowed({ canAuthor: false, orgOwnsStudy: true, publishedStudyUids: published, studyUid: "1.2.3" }),
    true
  );
  assert.equal(
    studyReadAllowed({ canAuthor: false, orgOwnsStudy: true, publishedStudyUids: published, studyUid: "9.9" }),
    false,
    "a study used only by a draft must not stream to the student demo"
  );
});

test("nobody reads a study the org does not own", () => {
  for (const canAuthor of [true, false]) {
    assert.equal(
      studyReadAllowed({ canAuthor, orgOwnsStudy: false, publishedStudyUids: published, studyUid: "1.2.3" }),
      false
    );
  }
});
