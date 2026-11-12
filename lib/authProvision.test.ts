import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canAccessOrgResource } from "./authRoles.ts";
import { SIGNUP_INTENT_COOKIE, SIGNUP_INTENT_HEADER } from "./signupIntent.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-auth-provision-"));
process.env.NODE_ENV = "test";
process.env.BETTER_AUTH_SECRET = "auth-provision-test-secret-32chars!!";

type Provision = typeof import("./authProvision.ts");

let provisionPromise: Promise<Provision> | null = null;

function provision(): Promise<Provision> {
  if (!provisionPromise) provisionPromise = import("./authProvision.ts");
  return provisionPromise;
}

test("Better Auth user.create hook passes the request intent into provisioning", () => {
  const src = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  const start = src.indexOf("databaseHooks:");
  const end = src.indexOf("plugins:", start);
  assert.ok(start >= 0 && end > start);
  const hook = src.slice(start, end);
  assert.match(hook, /applyAuthUserCreate\(user,\s*context\)/);
  assert.doesNotMatch(hook, /provisionAuthUser\(/);
  assert.match(src, /intent:\s*signupIntentFromRequest\(\)/);
});

test("sign-up path with a student cookie provisions a student who cannot author", async () => {
  const { applyAuthUserCreate } = await provision();
  const { listMembershipsForUser, DEFAULT_ORG_ID } = await import("./cases.ts");
  const user = await applyAuthUserCreate(
    { id: "ba_signup_student", email: "learner.signup@example.com", name: "Learner" },
    {
      request: {
        headers: new Headers({ cookie: `${SIGNUP_INTENT_COOKIE}=student` }),
      },
    }
  );

  assert.equal(user.orgId, DEFAULT_ORG_ID);
  assert.equal(user.role, "student");
  assert.equal(user.platformRole ?? null, null);
  const memberships = await listMembershipsForUser(user.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, "student");
  assert.equal(
    canAccessOrgResource({ membershipRole: memberships[0].role, need: "author" }),
    false
  );
});

test("sign-up path with a student header provisions a student", async () => {
  const { applyAuthUserCreate } = await provision();
  const { listMembershipsForUser, DEFAULT_ORG_ID } = await import("./cases.ts");
  const user = await applyAuthUserCreate(
    { id: "ba_signup_header", email: "header.learner@example.com", name: "Header Learner" },
    { headers: new Headers({ [SIGNUP_INTENT_HEADER]: "student" }) }
  );
  assert.equal(user.orgId, DEFAULT_ORG_ID);
  const memberships = await listMembershipsForUser(user.id);
  assert.equal(memberships[0].role, "student");
});

test("sign-up path without a student choice provisions a personal-org teacher", async () => {
  const { applyAuthUserCreate } = await provision();
  const { listMembershipsForUser, DEFAULT_ORG_ID } = await import("./cases.ts");
  const user = await applyAuthUserCreate(
    { id: "ba_signup_teacher", email: "teacher.signup@example.com", name: "Dr. Signup" },
    { request: { headers: new Headers() } }
  );
  assert.notEqual(user.orgId, DEFAULT_ORG_ID);
  assert.equal(user.platformRole ?? null, null);
  const memberships = await listMembershipsForUser(user.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, "author");
  assert.equal(memberships[0].orgId, user.orgId);
  assert.equal(
    canAccessOrgResource({ membershipRole: memberships[0].role, need: "author" }),
    true
  );
});

test("an admin or super_admin value on the sign-up path does not grant platform staff", async () => {
  const { applyAuthUserCreate } = await provision();
  const { listMembershipsForUser, DEFAULT_ORG_ID } = await import("./cases.ts");
  const user = await applyAuthUserCreate(
    { id: "ba_signup_admin_pretend", email: "pretend.admin@example.com", name: "Pretend" },
    {
      body: { intent: "super_admin" },
      headers: new Headers({ [SIGNUP_INTENT_HEADER]: "admin" }),
    }
  );
  assert.equal(user.platformRole ?? null, null);
  assert.notEqual(user.orgId, DEFAULT_ORG_ID);
  const memberships = await listMembershipsForUser(user.id);
  assert.equal(memberships[0].role, "author");
});

test("sign-up intent does not rewrite an existing membership", async () => {
  const { applyAuthUserCreate } = await provision();
  const { listMembershipsForUser } = await import("./cases.ts");

  const teacher = await applyAuthUserCreate(
    { id: "ba_keep_teacher", email: "keep.teacher@example.com", name: "Keep Teacher" },
    null
  );
  const teacherAgain = await applyAuthUserCreate(
    { id: "ba_keep_teacher", email: "keep.teacher@example.com", name: "Keep Teacher" },
    { request: { headers: new Headers({ cookie: `${SIGNUP_INTENT_COOKIE}=student` }) } }
  );
  assert.equal(teacherAgain.orgId, teacher.orgId);
  assert.equal(teacherAgain.platformRole ?? null, null);
  const teacherMemberships = await listMembershipsForUser(teacher.id);
  assert.equal(teacherMemberships.length, 1);
  assert.equal(teacherMemberships[0].role, "author");

  const student = await applyAuthUserCreate(
    { id: "ba_keep_student", email: "keep.student@example.com", name: "Keep Student" },
    { headers: new Headers({ [SIGNUP_INTENT_HEADER]: "student" }) }
  );
  const studentAgain = await applyAuthUserCreate(
    { id: "ba_keep_student", email: "keep.student@example.com", name: "Keep Student" },
    { headers: new Headers({ [SIGNUP_INTENT_HEADER]: "teacher" }) }
  );
  assert.equal(studentAgain.id, student.id);
  const studentMemberships = await listMembershipsForUser(student.id);
  assert.equal(studentMemberships.length, 1);
  assert.equal(studentMemberships[0].role, "student");
});
