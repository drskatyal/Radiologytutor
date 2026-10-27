import { test } from "node:test";
import assert from "node:assert/strict";
import { demoEntryDestination, demoRoleBody, safeNext } from "./demoEntry.ts";

test("safeNext allows in-app paths and rejects open redirects", () => {
  assert.equal(safeNext(undefined), "");
  assert.equal(safeNext(""), "");
  assert.equal(safeNext("https://evil.example"), "");
  assert.equal(safeNext("//evil.example"), "");
  assert.equal(safeNext("studio"), "");
  assert.equal(safeNext("/studio"), "/studio");
  assert.equal(safeNext("/studio/new"), "/studio/new");
  assert.equal(safeNext("/library"), "/library");
});

test("teacher entry posts author and lands on studio unless next is set", () => {
  assert.deepEqual(demoRoleBody("author"), { role: "author" });
  assert.equal(demoEntryDestination({ membershipRole: "author" }), "/studio");
  assert.equal(demoEntryDestination({ membershipRole: "author" }, "/studio/new"), "/studio/new");
  assert.equal(demoEntryDestination({ membershipRole: "author" }, "//evil.example"), "/studio");
});

test("student entry posts student and lands on the library", () => {
  assert.deepEqual(demoRoleBody("student"), { role: "student" });
  assert.equal(demoEntryDestination({ membershipRole: "student" }), "/library");
  assert.equal(
    demoEntryDestination({ membershipRole: "student" }, "https://evil.example"),
    "/library"
  );
});

test("continue-as-demo still follows the returned user, not a teacher default", () => {
  assert.deepEqual(demoRoleBody("super_admin"), { role: "super_admin" });
  assert.equal(
    demoEntryDestination({ platformRole: "super_admin", membershipRole: "owner" }),
    "/admin"
  );
});
