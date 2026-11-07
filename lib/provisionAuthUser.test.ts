import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canAccessOrgResource } from "./authRoles.ts";

// DATA_DIR is read when lib/cases.ts loads. Set it before the dynamic import.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-provision-"));
process.env.NODE_ENV = "test";

type Cases = typeof import("./cases.ts");

let casesPromise: Promise<Cases> | null = null;

function cases(): Promise<Cases> {
  if (!casesPromise) casesPromise = import("./cases.ts");
  return casesPromise;
}

test("public sign-up provisions a teacher on their own org, not a student seat in org_demo", async () => {
  const store = await cases();
  const user = await store.provisionAuthUser({
    authProviderId: "ba_teacher_ada",
    email: "ada@example.com",
    name: "Dr. Ada",
  });

  assert.notEqual(user.orgId, store.DEFAULT_ORG_ID);
  assert.equal(user.role, "author");

  const memberships = await store.listMembershipsForUser(user.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].orgId, user.orgId);
  assert.equal(memberships[0].role, "author");
  assert.equal(
    canAccessOrgResource({ membershipRole: memberships[0].role, need: "author" }),
    true
  );

  const org = await store.getOrg(user.orgId);
  assert.ok(org);
  assert.equal(org.id, user.orgId);
  assert.notEqual(org.id, store.DEFAULT_ORG_ID);

  const demoMembers = await store.listMemberships(store.DEFAULT_ORG_ID);
  assert.equal(
    demoMembers.some((membership) => membership.userId === user.id),
    false
  );

  const again = await store.provisionAuthUser({
    authProviderId: "ba_teacher_ada",
    email: "Ada@Example.com",
    name: "Dr. Ada",
  });
  assert.equal(again.orgId, user.orgId);
  const membershipsAgain = await store.listMembershipsForUser(user.id);
  assert.equal(membershipsAgain.length, 1);
  assert.equal(membershipsAgain[0].orgId, user.orgId);
  assert.equal(membershipsAgain[0].role, "author");
});

test("two public sign-ups do not share an org", async () => {
  const store = await cases();
  const first = await store.provisionAuthUser({
    authProviderId: "ba_teacher_one",
    email: "one@example.com",
    name: "One",
  });
  const second = await store.provisionAuthUser({
    authProviderId: "ba_teacher_two",
    email: "two@example.com",
    name: "Two",
  });
  assert.notEqual(first.orgId, second.orgId);
  assert.notEqual(first.orgId, store.DEFAULT_ORG_ID);
  assert.notEqual(second.orgId, store.DEFAULT_ORG_ID);
});

test("a home org with no membership is attached as author instead of a new org_demo seat", async () => {
  const store = await cases();
  const preset = await store.createUser({
    email: "preset@example.com",
    name: "Preset Teacher",
    orgId: "org_preset_teacher",
    role: "author",
    authProviderId: "ba_preset",
  });
  const user = await store.provisionAuthUser({
    authProviderId: "ba_preset",
    email: preset.email,
    name: "Preset Teacher",
  });
  assert.equal(user.orgId, "org_preset_teacher");
  const memberships = await store.listMembershipsForUser(user.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].orgId, "org_preset_teacher");
  assert.equal(memberships[0].role, "author");
  const org = await store.getOrg("org_preset_teacher");
  assert.ok(org);
  assert.equal(org.id, "org_preset_teacher");
});

test("explicit student sign-up stays a student in org_demo and cannot author", async () => {
  const store = await cases();
  const user = await store.provisionAuthUser({
    authProviderId: "ba_student",
    email: "learner@example.com",
    name: "Learner",
    intent: "student",
  });
  assert.equal(user.orgId, store.DEFAULT_ORG_ID);
  assert.equal(user.role, "student");
  const memberships = await store.listMembershipsForUser(user.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].orgId, store.DEFAULT_ORG_ID);
  assert.equal(memberships[0].role, "student");
  assert.equal(
    canAccessOrgResource({ membershipRole: memberships[0].role, need: "author" }),
    false
  );
  assert.equal(canAccessOrgResource({ membershipRole: null, need: "author" }), false);

  const linked = await store.provisionAuthUser({
    authProviderId: "ba_student",
    email: "learner@example.com",
    name: "Learner",
  });
  assert.equal(linked.orgId, store.DEFAULT_ORG_ID);
  const still = await store.listMembershipsForUser(user.id);
  assert.equal(still.length, 1);
  assert.equal(still[0].role, "student");
});
