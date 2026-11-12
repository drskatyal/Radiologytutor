import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-platform-route-"));
process.env.NODE_ENV = "test";
process.env.BETTER_AUTH_SECRET = "platform-route-test-secret-32chars!";

type PlatformRoute = typeof import("../app/api/admin/platform/route.ts");
type MembershipRoute = typeof import("../app/api/admin/platform/memberships/route.ts");

let platformPromise: Promise<PlatformRoute> | null = null;
let membershipPromise: Promise<MembershipRoute> | null = null;

function platformRoute(): Promise<PlatformRoute> {
  if (!platformPromise) platformPromise = import("../app/api/admin/platform/route.ts");
  return platformPromise;
}

function membershipRoute(): Promise<MembershipRoute> {
  if (!membershipPromise) {
    membershipPromise = import("../app/api/admin/platform/memberships/route.ts");
  }
  return membershipPromise;
}

test("platform directory and admin grant reject a signed-out caller", async () => {
  const platform = await platformRoute();
  const directory = await platform.GET();
  assert.equal(directory.status, 401);

  const grant = await platform.POST(
    new Request("http://127.0.0.1:3000/api/admin/platform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "future.admin@example.com" }),
    })
  );
  assert.equal(grant.status, 401);
  const body = (await grant.json()) as { error?: string };
  assert.equal(body.error, "Unauthorized");
});

test("platform membership changes reject a signed-out caller", async () => {
  const route = await membershipRoute();
  const res = await route.POST(
    new Request("http://127.0.0.1:3000/api/admin/platform/memberships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ membershipId: "mem_x", role: "admin" }),
    })
  );
  assert.equal(res.status, 401);
});
