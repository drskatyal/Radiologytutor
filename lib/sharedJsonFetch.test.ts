import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJsonShared, resetSharedJson, SHARED_TTL_MS } from "./sharedJsonFetch";

function fakeFetch(body: unknown, status = 200) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(body), { status });
  };
  return { impl, calls: () => calls };
}

test("concurrent callers share one request (prewarm + viewer)", async () => {
  resetSharedJson();
  const f = fakeFetch([{ a: 1 }]);
  const [a, b] = await Promise.all([
    fetchJsonShared("/x", { fetchImpl: f.impl }),
    fetchJsonShared("/x", { fetchImpl: f.impl }),
  ]);
  assert.equal(f.calls(), 1);
  assert.deepEqual(a, [{ a: 1 }]);
  assert.equal(a, b);
});

test("an entry expires after the open window", async () => {
  resetSharedJson();
  const f = fakeFetch({ ok: true });
  await fetchJsonShared("/y", { fetchImpl: f.impl, now: 0 });
  await fetchJsonShared("/y", { fetchImpl: f.impl, now: SHARED_TTL_MS + 1 });
  assert.equal(f.calls(), 2);
});

test("failures are not remembered", async () => {
  resetSharedJson();
  const bad = fakeFetch({}, 401);
  assert.equal(await fetchJsonShared("/z", { fetchImpl: bad.impl }), null);
  await new Promise((r) => setTimeout(r, 1));
  const good = fakeFetch({ fine: 1 });
  assert.deepEqual(await fetchJsonShared("/z", { fetchImpl: good.impl }), { fine: 1 });
});

test("one caller aborting does not cancel the other", async () => {
  resetSharedJson();
  const f = fakeFetch([1]);
  const ctrl = new AbortController();
  const first = fetchJsonShared("/w", { fetchImpl: f.impl, signal: ctrl.signal });
  const second = fetchJsonShared("/w", { fetchImpl: f.impl });
  ctrl.abort();
  await assert.rejects(first, /Abort/);
  assert.deepEqual(await second, [1]);
  assert.equal(f.calls(), 1);
});
