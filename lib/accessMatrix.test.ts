import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccessOrgResource, hasMembershipAccess } from "./authRoles.ts";
import { dashboardPath } from "./dashboardPath.ts";
import type { MembershipRole } from "./types.ts";

/**
 * Exhaustive org-role × capability matrix for marketplace access.
 * Keep in sync with requireRole() gates on APIs and page layouts.
 */

const ROLES: MembershipRole[] = ["student", "author", "admin", "owner"];

type Cap =
  | "read_catalog"
  | "enroll"
  | "open_published_case"
  | "open_draft_case"
  | "mutate_findings"
  | "upload_dicom"
  | "studio"
  | "admin_apis"
  | "promote_members"
  | "verify_teachers"
  | "teaching_admin_apis"; // case/course CRUD used by Studio

const NEED: Record<
  Exclude<Cap, "read_catalog" | "enroll" | "open_published_case">,
  MembershipRole | "session"
> = {
  open_draft_case: "author",
  mutate_findings: "author",
  upload_dicom: "author",
  studio: "author",
  teaching_admin_apis: "author",
  admin_apis: "admin",
  promote_members: "admin",
  verify_teachers: "admin",
};

function can(role: MembershipRole | null, cap: Cap, platformSuper = false): boolean {
  if (platformSuper) return true;
  if (cap === "read_catalog" || cap === "open_published_case") return true;
  if (cap === "enroll") return role != null; // any signed-in membership
  const need = NEED[cap];
  if (need === "session") return role != null;
  return hasMembershipAccess(role, need);
}

test("capability matrix: student cannot teach or admin", () => {
  assert.equal(can("student", "studio"), false);
  assert.equal(can("student", "upload_dicom"), false);
  assert.equal(can("student", "mutate_findings"), false);
  assert.equal(can("student", "open_draft_case"), false);
  assert.equal(can("student", "admin_apis"), false);
  assert.equal(can("student", "enroll"), true);
  assert.equal(can("student", "open_published_case"), true);
  assert.equal(can("student", "read_catalog"), true);
});

test("capability matrix: author can teach, not admin memberships", () => {
  assert.equal(can("author", "studio"), true);
  assert.equal(can("author", "upload_dicom"), true);
  assert.equal(can("author", "mutate_findings"), true);
  assert.equal(can("author", "open_draft_case"), true);
  assert.equal(can("author", "teaching_admin_apis"), true);
  assert.equal(can("author", "admin_apis"), false);
  assert.equal(can("author", "promote_members"), false);
  assert.equal(can("author", "verify_teachers"), false);
});

test("capability matrix: admin and owner get full org control", () => {
  for (const role of ["admin", "owner"] as MembershipRole[]) {
    assert.equal(can(role, "admin_apis"), true);
    assert.equal(can(role, "studio"), true);
    assert.equal(can(role, "promote_members"), true);
    assert.equal(can(role, "verify_teachers"), true);
  }
});

test("capability matrix: anonymous can read catalog and published cases only", () => {
  assert.equal(can(null, "read_catalog"), true);
  assert.equal(can(null, "open_published_case"), true);
  assert.equal(can(null, "enroll"), false);
  assert.equal(can(null, "studio"), false);
  assert.equal(can(null, "admin_apis"), false);
  assert.equal(can(null, "open_draft_case"), false);
});

test("super_admin bypasses every org capability", () => {
  for (const cap of Object.keys(NEED) as Cap[]) {
    assert.equal(can(null, cap, true), true, cap);
  }
});

test("dashboardPath matrix covers every membership role", () => {
  const expected: Record<MembershipRole, string> = {
    student: "/library",
    author: "/studio",
    admin: "/admin",
    owner: "/admin",
  };
  for (const role of ROLES) {
    assert.equal(
      dashboardPath({ signedIn: true, membershipRole: role }),
      expected[role],
      role
    );
  }
});

test("canAccessOrgResource rejects lower roles for each need", () => {
  const needs: MembershipRole[] = ["student", "author", "admin", "owner"];
  for (const need of needs) {
    for (const have of ROLES) {
      const ok = canAccessOrgResource({ membershipRole: have, need });
      assert.equal(ok, hasMembershipAccess(have, need), `${have} vs need ${need}`);
    }
  }
});
