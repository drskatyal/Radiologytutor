import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardPath } from "./dashboardPath.ts";
import { canAccessOrgResource } from "./authRoles.ts";

// DATA_DIR is read when lib/cases.ts loads. Set it before the dynamic import.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-demo-auth-"));
process.env.BETTER_AUTH_SECRET = "demo-auth-test-secret-32chars-min!!";
// Hermetic: a parent shell may export NODE_ENV=production. Dev persona tests
// opt back into the non-production cap; production cases set the env themselves.
process.env.NODE_ENV = "test";
delete process.env.DEMO_AUTH_ENABLED;
delete process.env.DEMO_AUTH_MAX_ROLE;

type DemoRoute = typeof import("../app/api/auth/demo/route.ts");
type Cases = typeof import("./cases.ts");

let routePromise: Promise<DemoRoute> | null = null;
let casesPromise: Promise<Cases> | null = null;

function route(): Promise<DemoRoute> {
  if (!routePromise) routePromise = import("../app/api/auth/demo/route.ts");
  return routePromise;
}

function cases(): Promise<Cases> {
  if (!casesPromise) casesPromise = import("./cases.ts");
  return casesPromise;
}

interface DemoUser {
  id: string;
  email: string;
  name: string | null;
  membershipRole: string | null;
  platformRole: string | null;
}

function cookieSub(setCookie: string | null): string | null {
  const match = setCookie?.match(/flowrad_demo=([^;]+)/);
  if (!match) return null;
  const payload = match[1].split(".")[0];
  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sub?: string;
  };
  return json.sub ?? null;
}

async function postDemo(role?: string) {
  const { POST } = await route();
  const init: RequestInit = { method: "POST" };
  if (role !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify({ role });
  }
  const res = await POST(new Request("http://127.0.0.1:3000/api/auth/demo", init));
  const body = (await res.json()) as { user?: DemoUser; error?: string };
  return { status: res.status, body, cookie: res.headers.get("set-cookie") };
}

describe("demo auth personas", { concurrency: false }, () => {
test("POST /api/auth/demo role=author restores the teacher, not the student", async () => {
  const store = await cases();
  const author = await postDemo("author");
  assert.equal(author.status, 200, author.body.error);
  assert.equal(author.body.user?.id, "user_teacher");
  assert.equal(author.body.user?.email, "teacher@flowrad.local");
  assert.equal(author.body.user?.name, "Dr. Priya Katyal");
  assert.equal(author.body.user?.membershipRole, "author");
  assert.equal(author.body.user?.platformRole ?? null, null);
  assert.equal(cookieSub(author.cookie), "user_teacher");
  assert.equal(
    dashboardPath({
      signedIn: true,
      platformRole: author.body.user?.platformRole,
      membershipRole: author.body.user?.membershipRole as "author",
    }),
    "/studio"
  );
  assert.equal(
    canAccessOrgResource({
      platformRole: author.body.user?.platformRole,
      membershipRole: "author",
      need: "author",
    }),
    true
  );

  const membership = await store.getMembershipForUserOrg("user_teacher", "org_demo");
  assert.equal(membership?.role, "author");
  assert.equal(membership?.id, "mem_demo_teacher");

  // A previous bug left the teacher membership as student. Signing in again
  // must put the author role back, not keep the learner gate.
  assert.ok(membership);
  await store.updateMembership(membership.id, { role: "student" });
  const restored = await postDemo("author");
  assert.equal(restored.body.user?.membershipRole, "author");
  assert.equal(restored.body.user?.id, "user_teacher");
  const membershipAgain = await store.getMembershipForUserOrg("user_teacher", "org_demo");
  assert.equal(membershipAgain?.role, "author");
});

test("POST /api/auth/demo role=student stays a student and does not demote the teacher", async () => {
  const store = await cases();
  await postDemo("author");
  const student = await postDemo("student");
  assert.equal(student.status, 200, student.body.error);
  assert.equal(student.body.user?.id, "user_student");
  assert.equal(student.body.user?.email, "student@flowrad.local");
  assert.equal(student.body.user?.name, "Demo Student");
  assert.equal(student.body.user?.membershipRole, "student");
  assert.equal(student.body.user?.platformRole ?? null, null);
  assert.equal(cookieSub(student.cookie), "user_student");
  assert.equal(
    dashboardPath({
      signedIn: true,
      membershipRole: "student",
    }),
    "/library"
  );
  assert.equal(
    canAccessOrgResource({ membershipRole: "student", need: "author" }),
    false
  );

  const teacher = await store.getMembershipForUserOrg("user_teacher", "org_demo");
  assert.equal(teacher?.role, "author");
  const learner = await store.getMembershipForUserOrg("user_student", "org_demo");
  assert.equal(learner?.role, "student");
  assert.equal(learner?.id, "mem_demo_student");
});

test("Continue as demo still mints the platform super-admin outside production", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const demo = await postDemo("super_admin");
    assert.equal(demo.status, 200);
    assert.equal(demo.body.user?.id, "user_demo");
    assert.equal(demo.body.user?.platformRole, "super_admin");
    assert.equal(demo.body.user?.membershipRole, "owner");
    assert.notEqual(demo.body.user?.name, "Demo Student");
    assert.equal(
      dashboardPath({
        signedIn: true,
        platformRole: "super_admin",
        membershipRole: "owner",
      }),
      "/admin"
    );
  } finally {
    process.env.NODE_ENV = previous;
  }
});

async function withProdDemo(cap: string | undefined, run: () => Promise<void>) {
  const previousNode = process.env.NODE_ENV;
  const previousFlag = process.env.DEMO_AUTH_ENABLED;
  const previousCap = process.env.DEMO_AUTH_MAX_ROLE;
  process.env.NODE_ENV = "production";
  process.env.DEMO_AUTH_ENABLED = "1";
  if (cap === undefined) delete process.env.DEMO_AUTH_MAX_ROLE;
  else process.env.DEMO_AUTH_MAX_ROLE = cap;
  try {
    await run();
  } finally {
    process.env.NODE_ENV = previousNode;
    if (previousFlag === undefined) delete process.env.DEMO_AUTH_ENABLED;
    else process.env.DEMO_AUTH_ENABLED = previousFlag;
    if (previousCap === undefined) delete process.env.DEMO_AUTH_MAX_ROLE;
    else process.env.DEMO_AUTH_MAX_ROLE = previousCap;
  }
}

// P0: production let any anonymous visitor POST {role:"author"} and become an
// author in the shared demo org — drafts and registered studies exposed.
test("production refuses anonymous author / admin demo with 403 and sets no cookie", async () => {
  await withProdDemo(undefined, async () => {
    for (const role of ["author", "teacher", "super_admin", "admin", "owner"]) {
      const res = await postDemo(role);
      assert.equal(res.status, 403, `${role} must be refused`);
      assert.equal(res.body.user, undefined, role);
      assert.equal(cookieSub(res.cookie), null, `${role} must not get a demo cookie`);
    }
  });
});

test("no environment knob re-opens elevated demo in production", async () => {
  for (const cap of ["author", "super_admin", " author "]) {
    await withProdDemo(cap, async () => {
      const res = await postDemo("author");
      assert.equal(res.status, 403, `DEMO_AUTH_MAX_ROLE=${cap}`);
    });
  }
});

test("production still offers the student demo, explicitly or by empty body", async () => {
  await withProdDemo(undefined, async () => {
    const student = await postDemo("student");
    assert.equal(student.status, 200, student.body.error);
    assert.equal(student.body.user?.id, "user_student");
    assert.equal(student.body.user?.membershipRole, "student");
    assert.equal(cookieSub(student.cookie), "user_student");

    const empty = await postDemo();
    assert.equal(empty.status, 200, empty.body.error);
    assert.equal(empty.body.user?.id, "user_student");
    assert.notEqual(empty.body.user?.platformRole, "super_admin");
  });
});

test("a teacher/admin demo cookie minted before the lockdown no longer resolves in production", async () => {
  const { demoIdentityAllowed } = await import("./auth.ts");
  await withProdDemo(undefined, async () => {
    assert.equal(demoIdentityAllowed("user_teacher"), false);
    assert.equal(demoIdentityAllowed("user_demo"), false);
    assert.equal(demoIdentityAllowed("user_student"), true);
  });
  assert.equal(demoIdentityAllowed("user_teacher"), true, "local dev keeps every persona");
});

test("DEMO_AUTH_MAX_ROLE=student locks the dev Teacher demo to a learner", async () => {
  const previousCap = process.env.DEMO_AUTH_MAX_ROLE;
  process.env.DEMO_AUTH_MAX_ROLE = "student";
  try {
    const author = await postDemo("author");
    assert.equal(author.body.user?.membershipRole, "student");
    assert.equal(author.body.user?.id, "user_student");
  } finally {
    if (previousCap === undefined) delete process.env.DEMO_AUTH_MAX_ROLE;
    else process.env.DEMO_AUTH_MAX_ROLE = previousCap;
  }
});
});
