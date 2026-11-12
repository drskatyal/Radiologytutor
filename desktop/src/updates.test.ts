// Update scheduling and the licence / feature-flag seam. Run: npm --prefix desktop test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUSY_RETRY_MS, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, describeCheckError, nextCheckInMs } from "./updateSchedule";
import { DEFAULT_ENTITLEMENT, FREE_CORE_FEATURES, __setEntitlementForTest, getEntitlement, isEnabled, isPaid, normalise } from "./licence";

test("updates: nothing before first paint, first check 10 s after it, then every 4 h", () => {
  const base = { enabled: true, busy: false };
  assert.equal(nextCheckInMs({ ...base, sinceFirstPaintMs: null, sinceLastCheckMs: null }), FIRST_CHECK_DELAY_MS);
  assert.equal(nextCheckInMs({ ...base, sinceFirstPaintMs: 4_000, sinceLastCheckMs: null }), FIRST_CHECK_DELAY_MS - 4_000);
  assert.equal(nextCheckInMs({ ...base, sinceFirstPaintMs: 60_000, sinceLastCheckMs: null }), 0);
  assert.equal(nextCheckInMs({ ...base, sinceFirstPaintMs: 60_000, sinceLastCheckMs: 1_000 }), CHECK_INTERVAL_MS - 1_000);
  assert.equal(CHECK_INTERVAL_MS, 4 * 3_600_000);
});

test("updates: a due check waits while a study is opening; off means never", () => {
  assert.equal(nextCheckInMs({ enabled: true, busy: true, sinceFirstPaintMs: 60_000, sinceLastCheckMs: null }), BUSY_RETRY_MS);
  assert.equal(nextCheckInMs({ enabled: false, busy: false, sinceFirstPaintMs: 60_000, sinceLastCheckMs: null }), null);
});

test("updates: check errors read as plain language", () => {
  assert.match(describeCheckError("error sending request: dns error"), /offline/);
  assert.match(describeCheckError("signature verification failed"), /signature/);
  assert.match(describeCheckError({}), /try again later/);
});

test("licence: free with everything on until a config says otherwise", () => {
  __setEntitlementForTest(null);
  assert.deepEqual(getEntitlement(), DEFAULT_ENTITLEMENT);
  assert.equal(isPaid(), false);
  assert.equal(isEnabled("anything"), true);
  assert.equal(isEnabled("experimental", false), false);
});

test("licence: flags and tier come only from a well-formed entitlement", () => {
  __setEntitlementForTest({ tier: "paid", features: { cloudSync: true, newMprUi: false, junk: "yes" }, source: "remote", licensee: "Clinic" });
  assert.equal(isPaid(), true);
  assert.equal(isEnabled("cloudSync"), true);
  assert.equal(isEnabled("newMprUi"), false);
  assert.equal(isEnabled("junk"), true, "non-boolean flags are ignored");
  assert.deepEqual(normalise({ tier: "platinum", source: "evil" }), { ...DEFAULT_ENTITLEMENT, expiresAt: null, licensee: null, message: null });
  __setEntitlementForTest(null);
});

test("licence: 3D MPR and the 3D volume are free core, never gated or switched off", () => {
  assert.deepEqual([...FREE_CORE_FEATURES].sort(), ["mpr", "volume-3d"]);
  const off = Object.fromEntries(FREE_CORE_FEATURES.map((f) => [f, false]));
  for (const tier of ["free", "paid"]) {
    __setEntitlementForTest({ tier, features: { ...off, cloudSync: false }, source: "remote" });
    for (const f of FREE_CORE_FEATURES) {
      assert.equal(isEnabled(f), true, `${f} on (${tier})`);
      assert.equal(isEnabled(f, false), true, `${f} ignores a false fallback (${tier})`);
      assert.equal(getEntitlement().features[f], true, `${f} reported on (${tier})`);
    }
    assert.equal(isEnabled("cloudSync"), false, "other features can still be gated");
  }
  __setEntitlementForTest(null);
  // The Rust resolver carries the same list.
  const rust = readFileSync(new URL("../src-tauri/src/updates.rs", import.meta.url), "utf8");
  const m = /FREE_CORE_FEATURES: &\[&str\] = &\[([^\]]*)\]/.exec(rust);
  assert.ok(m, "updates.rs defines FREE_CORE_FEATURES");
  assert.deepEqual(m[1].split(",").map((s) => s.trim().replace(/"/g, "")).sort(), [...FREE_CORE_FEATURES].sort());
});

test("updates: the app sends nothing identifying (fixed URLs, no arguments)", () => {
  // The front end calls these with no arguments: nothing about studies,
  // paths or the user can reach the update / config requests.
  const hook = readFileSync(new URL("./components/useUpdater.ts", import.meta.url), "utf8");
  for (const cmd of ["update_check", "update_apply", "update_mark_healthy"]) {
    const calls = [...hook.matchAll(new RegExp(`invoke(?:<[^>]*>)?\\("${cmd}"([^)]*)\\)`, "g"))];
    assert.ok(calls.length > 0, `${cmd} is called`);
    for (const c of calls) assert.equal(c[1].trim(), "", `${cmd} takes no arguments`);
  }
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  for (const url of conf.plugins.updater.endpoints as string[]) {
    assert.ok(url.startsWith("https://") && !url.includes("?") && !url.includes("{{"), url);
  }
  assert.ok(!String(conf.plugins.updater.pubkey).startsWith("REPLACED"), "a real public key is baked in");
});
