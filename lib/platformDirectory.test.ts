import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlatformSuperAdmin } from "./authRoles.ts";
import { dashboardPath } from "./dashboardPath.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-platform-dir-"));
process.env.NODE_ENV = "test";

type Cases = typeof import("./cases.ts");

let casesPromise: Promise<Cases> | null = null;

function cases(): Promise<Cases> {
  if (!casesPromise) casesPromise = import("./cases.ts");
  return casesPromise;
}

test("platform directory lists every teacher org, private drafts, members, and teaching activity", async () => {
  const store = await cases();
  const ada = await store.provisionAuthUser({
    authProviderId: "ba_ada_platform",
    email: "ada.platform@example.com",
    name: "Dr. Ada",
  });
  const grace = await store.provisionAuthUser({
    authProviderId: "ba_grace_platform",
    email: "grace.platform@example.com",
    name: "Dr. Grace",
  });
  const learner = await store.provisionAuthUser({
    authProviderId: "ba_learner_platform",
    email: "learner.platform@example.com",
    name: "Learner",
    intent: "student",
  });

  const draft = await store.createCaseForOrg(grace.orgId, {
    title: "Grace private draft",
    modality: "CT",
    pacsbinBaseUrl: "/cornerstone",
    status: "draft",
  });

  const adaCases = await store.listCasesForOrg(ada.orgId);
  const learnerCases = await store.listCasesForOrg(learner.orgId);
  assert.equal(
    adaCases.some((row) => row.caseId === draft.caseId),
    false
  );
  assert.equal(
    learnerCases.some((row) => row.caseId === draft.caseId),
    false
  );

  const before = await store.getPlatformDirectory();
  await store.createEnrollment({
    userId: learner.id,
    orgId: learner.orgId,
    courseId: "course_platform_probe",
  });
  const directory = await store.getPlatformDirectory();

  const adaRow = directory.teachers.find((row) => row.email === ada.email);
  const graceRow = directory.teachers.find((row) => row.email === grace.email);
  assert.ok(adaRow);
  assert.ok(graceRow);
  assert.equal(adaRow.orgId, ada.orgId);
  assert.equal(graceRow.orgId, grace.orgId);
  assert.notEqual(adaRow.orgId, graceRow.orgId);
  assert.equal(adaRow.role, "author");
  assert.equal(graceRow.role, "author");
  assert.ok(graceRow.orgName);
  assert.equal(graceRow.draftCases >= 1, true);

  assert.equal(
    directory.teachers.some((row) => row.email === learner.email && row.role === "student"),
    false
  );
  const learnerMember = directory.members.find((row) => row.email === learner.email);
  assert.ok(learnerMember);
  assert.equal(learnerMember.role, "student");
  assert.equal(learnerMember.orgId, store.DEFAULT_ORG_ID);

  const draftRow = directory.cases.find((row) => row.caseId === draft.caseId);
  assert.ok(draftRow);
  assert.equal(draftRow.status, "draft");
  assert.equal(draftRow.orgId, grace.orgId);
  assert.equal(draftRow.findingCount, 0);

  assert.equal(directory.activity.enrollmentCount, before.activity.enrollmentCount + 1);
  assert.equal(directory.activity.teacherCount >= 2, true);
  assert.equal(directory.activity.studentCount >= 1, true);
  assert.equal(directory.activity.draftCases >= 1, true);
  assert.equal(
    directory.activity.findingCount,
    directory.cases.reduce((sum, row) => sum + row.findingCount, 0)
  );
});

test("platform admin is granted to an existing account and is not a public role", async () => {
  const store = await cases();
  await assert.rejects(
    () => store.grantPlatformAdminByEmail("nobody.platform@example.com"),
    (err: unknown) => {
      assert.ok(err instanceof store.AccountNotFoundError);
      return true;
    }
  );

  const learner = await store.provisionAuthUser({
    authProviderId: "ba_future_admin",
    email: "future.admin@example.com",
    name: "Future Admin",
    intent: "student",
  });
  assert.equal(isPlatformSuperAdmin(learner.platformRole), false);

  const granted = await store.grantPlatformAdminByEmail("Future.Admin@example.com");
  assert.equal(granted.id, learner.id);
  assert.equal(granted.platformRole, "super_admin");
  const memberships = await store.listMembershipsForUser(learner.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, "student");
  assert.equal(
    dashboardPath({
      signedIn: true,
      platformRole: granted.platformRole,
      membershipRole: memberships[0].role,
    }),
    "/admin"
  );

  const again = await store.grantPlatformAdminByEmail(granted.email);
  assert.equal(again.platformRole, "super_admin");
  const still = await store.listMembershipsForUser(learner.id);
  assert.equal(still[0].role, "student");

  assert.equal(isPlatformSuperAdmin(null), false);
  assert.equal(isPlatformSuperAdmin("super_admin"), true);
});

test("platform membership changes update the directory and stay off the public sign-up role", async () => {
  const store = await cases();
  const teacher = await store.provisionAuthUser({
    authProviderId: "ba_role_edit",
    email: "role.edit@example.com",
    name: "Role Edit",
  });
  const directory = await store.getPlatformDirectory();
  const row = directory.members.find((member) => member.email === teacher.email);
  assert.ok(row);
  assert.equal(row.role, "author");

  const updated = await store.updateMembership(row.membershipId, { role: "admin" });
  assert.ok(updated);
  assert.equal(updated.role, "admin");
  assert.equal(updated.orgId, teacher.orgId);
  const after = await store.getPlatformDirectory();
  const next = after.members.find((member) => member.membershipId === row.membershipId);
  assert.equal(next?.role, "admin");
  const user = await store.getUser(teacher.id);
  assert.equal(user?.platformRole ?? null, null);
});
