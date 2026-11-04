import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENTITLEMENT } from "./licence/index";
import {
  featureAllowed,
  fetchAccountEntitlement,
  mergeAccountEntitlement,
  parseAccountEntitlement,
  pollDeviceLink,
  startDeviceLink,
  type Http,
} from "./licence/account";

const SERVER = "https://viewer.flowrad.ai";
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

test("device link: start, pending, approved (token once), and a foreign verify URL is refused", async () => {
  const calls: string[] = [];
  let approved = false;
  const http: Http = async ({ method, url, bearer }) => {
    calls.push(`${method} ${url}${bearer ? " +bearer" : ""}`);
    if (method === "POST") return { status: 201, body: { pollId: "p".repeat(32), userCode: "ABCD-EFGH", verifyUrl: `${SERVER}/desktop/link?code=ABCD-EFGH`, expiresAt: future, intervalSec: 5 } };
    if (url.endsWith("/entitlement")) return { status: 200, body: { plan: "pro", tier: "paid", features: { pacs: true }, issuedAt: "", expiresAt: future, signed: false } };
    return approved
      ? { status: 200, body: { status: "approved", deviceToken: "tok", account: { email: "a@b.co" }, entitlement: { plan: "free", features: {}, expiresAt: future } } }
      : { status: 200, body: { status: "pending" } };
  };
  const start = await startDeviceLink(http, SERVER, "Reading room PC");
  assert.equal(start.userCode, "ABCD-EFGH");
  assert.deepEqual(await pollDeviceLink(http, SERVER, start.pollId), { status: "pending" });
  approved = true;
  const done = await pollDeviceLink(http, SERVER, start.pollId);
  assert.equal(done.status, "approved");
  const ent = await fetchAccountEntitlement(http, SERVER, "tok");
  assert.equal(ent?.plan, "pro");
  assert.ok(calls.at(-1)?.endsWith("/api/desktop/entitlement +bearer"));

  const evil: Http = async () => ({ status: 201, body: { pollId: "p".repeat(32), userCode: "ABCD-EFGH", verifyUrl: "https://evil.example/x" } });
  await assert.rejects(startDeviceLink(evil, SERVER, "x"), /Unexpected sign-in address/);
  await assert.rejects(startDeviceLink(evil, "http://viewer.flowrad.ai", "x"), /HTTPS/);
});

test("an unsigned account answer can only add, never switch a feature off", () => {
  const local = { ...DEFAULT_ENTITLEMENT, features: { pacs: true } };
  const acct = parseAccountEntitlement({ plan: "pro", features: { pacs: false, fusion: true }, expiresAt: future, signed: false })!;
  const merged = mergeAccountEntitlement(local, acct);
  assert.equal(merged.tier, "paid");
  assert.equal(featureAllowed(merged, "pacs"), true, "unsigned 'false' is ignored");
  assert.equal(featureAllowed(merged, "fusion"), true);
  assert.equal(featureAllowed(merged, "anything-unknown"), true);
});

test("expired or malformed account answers are ignored (local entitlement stands)", () => {
  const expired = parseAccountEntitlement({ plan: "super", features: {}, expiresAt: past, signed: false });
  assert.equal(mergeAccountEntitlement(DEFAULT_ENTITLEMENT, expired).tier, "free");
  assert.equal(parseAccountEntitlement({ plan: "gold", expiresAt: future }), null);
  assert.equal(parseAccountEntitlement(null), null);
});
