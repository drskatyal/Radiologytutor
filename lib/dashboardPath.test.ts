import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardPath } from "./dashboardPath.ts";

test("signed-out users go to sign-in", () => {
  assert.equal(dashboardPath({ signedIn: false }), "/sign-in");
});

test("super-admin always lands on Admin", () => {
  assert.equal(
    dashboardPath({ signedIn: true, platformRole: "super_admin", membershipRole: "student" }),
    "/admin"
  );
});

test("org admin and owner land on Admin", () => {
  assert.equal(dashboardPath({ signedIn: true, membershipRole: "admin" }), "/admin");
  assert.equal(dashboardPath({ signedIn: true, membershipRole: "owner" }), "/admin");
});

test("authors land on Studio", () => {
  assert.equal(dashboardPath({ signedIn: true, membershipRole: "author" }), "/studio");
});

test("students land on Library", () => {
  assert.equal(dashboardPath({ signedIn: true, membershipRole: "student" }), "/library");
});

test("signed in without a membership returns null (stub hub)", () => {
  assert.equal(dashboardPath({ signedIn: true }), null);
  assert.equal(dashboardPath({ signedIn: true, membershipRole: null }), null);
});
