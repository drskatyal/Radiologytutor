import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPlaceholderAssessment,
  isPlaceholderAuthor,
  isPlaceholderCatalogCase,
  isPlaceholderCourse,
  isPlaceholderPlaylist,
  isPlaceholderSeedFile,
  toLearnerCatalog,
} from "./catalogPlaceholders.ts";

test("seed filenames for demo courses, playlists, assessments, and the demo author are skipped", () => {
  assert.equal(isPlaceholderSeedFile("course_demo.json"), true);
  assert.equal(isPlaceholderSeedFile("course_chest_registrar.json"), true);
  assert.equal(isPlaceholderSeedFile("pl_demo.json"), true);
  assert.equal(isPlaceholderSeedFile("assess_demo.json"), true);
  assert.equal(isPlaceholderSeedFile("auth_demo.json"), true);
  assert.equal(isPlaceholderSeedFile("case-lidc-nodule-search.json"), false);
  assert.equal(isPlaceholderSeedFile("user_teacher.json"), false);
});

test("placeholder courses and the demo author stay out of the learner catalog", () => {
  assert.equal(isPlaceholderCourse({ id: "course_demo", title: "Anything" }), true);
  assert.equal(
    isPlaceholderCourse({
      id: "course_real",
      title: "Foundations of Cross-Sectional Reading",
    }),
    true
  );
  assert.equal(
    isPlaceholderCourse({ id: "course_real", title: "Chest teaching", authorId: "auth_demo" }),
    true
  );
  assert.equal(
    isPlaceholderCourse({ id: "course_real", title: "Chest teaching", authorId: "auth_real" }),
    false
  );
  assert.equal(isPlaceholderAuthor({ id: "auth_demo", name: "Dr. Priya Katyal" }), true);
  assert.equal(isPlaceholderAuthor({ id: "auth_real", name: "Demo Teacher" }), true);
  assert.equal(isPlaceholderAuthor({ id: "auth_real", name: "Amira Shah" }), false);
  assert.equal(isPlaceholderPlaylist({ id: "pl_demo" }), true);
  assert.equal(isPlaceholderPlaylist({ id: "pl_real", title: "Night list" }), false);
  assert.equal(isPlaceholderAssessment({ id: "assess_demo" }), true);
  assert.equal(isPlaceholderAssessment({ id: "assess_real", courseId: "course_demo" }), true);
});

test("a seeded case attributed to the demo author is hidden until a real author publishes it", () => {
  assert.equal(
    isPlaceholderCatalogCase({ authorId: "auth_demo" }),
    true
  );
  assert.equal(isPlaceholderCatalogCase({ authorId: "auth_real" }), false);
  assert.equal(isPlaceholderCatalogCase({}), false);

  const visible = toLearnerCatalog({
    cases: [
      { authorId: "auth_demo", caseId: "case-lidc-nodule-search" },
      { authorId: "auth_real", caseId: "case_recorded" },
    ],
    courses: [
      { id: "course_demo", title: "Foundations of Cross-Sectional Reading" },
      { id: "course_real", title: "Registrar chest", authorId: "auth_real" },
    ],
    playlists: [
      { id: "pl_demo", title: "Continue where you left off" },
      { id: "pl_real", title: "This week" },
    ],
    authors: [
      { id: "auth_demo", name: "Dr. Priya Katyal" },
      { id: "auth_real", name: "Amira Shah" },
    ],
  });

  assert.deepEqual(
    visible.cases.map((item) => item.caseId),
    ["case_recorded"]
  );
  assert.deepEqual(
    visible.courses.map((item) => item.id),
    ["course_real"]
  );
  assert.deepEqual(
    visible.playlists.map((item) => item.id),
    ["pl_real"]
  );
  assert.deepEqual(
    visible.authors.map((item) => item.id),
    ["auth_real"]
  );
});
