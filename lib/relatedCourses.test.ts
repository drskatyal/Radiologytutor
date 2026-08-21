import { test } from "node:test";
import assert from "node:assert/strict";
import type { Course } from "./types.ts";
import { scoreRelatedCourse, sortRelatedCourses } from "./relatedCourses.ts";

function course(partial: Partial<Course> & Pick<Course, "id" | "title">): Course {
  return {
    orgId: "org_demo",
    caseIds: [],
    status: "published",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...partial,
  };
}

test("scoreRelatedCourse awards points for matching system, difficulty, and author", () => {
  const source = course({
    id: "src",
    title: "Source",
    system: "Chest",
    difficulty: "beginner",
    authorId: "auth_a",
  });

  assert.equal(scoreRelatedCourse(source, course({ id: "a", title: "A" })), 0);
  assert.equal(
    scoreRelatedCourse(source, course({ id: "b", title: "B", system: "Chest" })),
    3
  );
  assert.equal(
    scoreRelatedCourse(
      source,
      course({ id: "c", title: "C", difficulty: "beginner", authorId: "auth_a" })
    ),
    4
  );
  assert.equal(
    scoreRelatedCourse(
      source,
      course({
        id: "d",
        title: "D",
        system: "Chest",
        difficulty: "beginner",
        authorId: "auth_a",
      })
    ),
    7
  );
});

test("sortRelatedCourses orders by score desc then title", () => {
  const source = course({
    id: "src",
    title: "Source",
    system: "Chest",
    difficulty: "beginner",
    authorId: "auth_a",
  });

  const sorted = sortRelatedCourses(source, [
    course({ id: "low", title: "Alpha", system: "Neuro" }),
    course({ id: "mid", title: "Bravo", system: "Chest" }),
    course({
      id: "high",
      title: "Charlie",
      system: "Chest",
      difficulty: "beginner",
      authorId: "auth_a",
    }),
    course({ id: "tie-b", title: "Bravo tie", system: "Chest" }),
    course({ id: "tie-a", title: "Alpha tie", system: "Chest" }),
  ]);

  assert.deepEqual(
    sorted.map((c) => c.id),
    ["high", "tie-a", "mid", "tie-b", "low"]
  );
});
