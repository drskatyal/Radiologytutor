import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canAccessOrgResource,
  hasMembershipAccess,
  isPlatformSuperAdmin,
  membershipRank,
} from "./authRoles.ts";

test("membershipRank orders student < author < admin < owner", () => {
  assert.ok(membershipRank("student") < membershipRank("author"));
  assert.ok(membershipRank("author") < membershipRank("admin"));
  assert.ok(membershipRank("admin") < membershipRank("owner"));
});

test("hasMembershipAccess allows equal or higher roles", () => {
  assert.equal(hasMembershipAccess("author", "author"), true);
  assert.equal(hasMembershipAccess("admin", "author"), true);
  assert.equal(hasMembershipAccess("student", "author"), false);
  assert.equal(hasMembershipAccess(null, "student"), false);
});

test("super_admin bypasses org membership", () => {
  assert.equal(isPlatformSuperAdmin("super_admin"), true);
  assert.equal(
    canAccessOrgResource({
      platformRole: "super_admin",
      membershipRole: null,
      need: "owner",
    }),
    true
  );
  assert.equal(
    canAccessOrgResource({
      platformRole: null,
      membershipRole: "student",
      need: "admin",
    }),
    false
  );
});
