import { test } from "node:test";
import assert from "node:assert/strict";
import { signSession } from "./session.ts";
import {
  DESKTOP_FEATURES,
  FREE_CORE_FEATURES,
  PAID_FEATURES,
  bearerToken,
  deviceLinkExpired,
  entitlementForPlan,
  newDeviceLink,
  normaliseUserCode,
  signDeviceToken,
  verifyDeviceToken,
} from "./entitlements.ts";

const env = { NODE_ENV: "test", SESSION_SECRET: "s".repeat(32) } as unknown as NodeJS.ProcessEnv;

test("nothing is gated today: every feature on for every plan, entitlement unsigned", () => {
  assert.deepEqual(PAID_FEATURES, {});
  for (const plan of ["free", "pro", "super"]) {
    const e = entitlementForPlan(plan);
    assert.ok(DESKTOP_FEATURES.every((f) => e.features[f] === true), plan);
    assert.equal(e.signed, false);
  }
  assert.equal(entitlementForPlan("pro").tier, "paid");
  assert.equal(entitlementForPlan("nonsense").plan, "free");
});

test("device tokens verify, expire, and are not interchangeable with session cookies", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const t = signDeviceToken("u1", now, env);
  assert.equal(verifyDeviceToken(t, now + 1000, env), "u1");
  assert.equal(verifyDeviceToken(t, now + 91 * 86_400_000, env), null);
  assert.equal(verifyDeviceToken(t, now, { ...env, SESSION_SECRET: "t".repeat(32) } as NodeJS.ProcessEnv), null);
  assert.equal(verifyDeviceToken(signSession({ id: "u1", email: "a@b.co" }, now, env), now, env), null, "session cookie is not a device token");
});

test("device link codes: readable, normalised, expiring", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const link = newDeviceLink("  Radiology PC 3  ", now);
  assert.match(link.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normaliseUserCode(link.userCode.toLowerCase().replace("-", " ")), link.userCode);
  assert.equal(normaliseUserCode("ABCD-EF0O"), null);
  assert.equal(link.deviceName, "Radiology PC 3");
  assert.equal(deviceLinkExpired(link, now + 9 * 60_000), false);
  assert.equal(deviceLinkExpired(link, now + 11 * 60_000), true);
  assert.equal(bearerToken("Bearer abc.def"), "abc.def");
  assert.equal(bearerToken("Basic x"), null);
});

test("3D MPR is free core: never a paid feature", () => {
  assert.deepEqual([...FREE_CORE_FEATURES].sort(), ["mpr", "volume-3d"]);
  for (const f of FREE_CORE_FEATURES) assert.equal(PAID_FEATURES[f], undefined, f);
  for (const plan of ["free", "pro", "super"]) {
    const e = entitlementForPlan(plan);
    assert.equal(e.features.mpr && e.features["volume-3d"], true, plan);
  }
});
