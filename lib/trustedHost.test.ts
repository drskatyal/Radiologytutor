import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { configuredPublicOrigin, PROXY_SECRET_HEADER, trustedPublicOrigin, validForwardedHostname, type RequestHeaders } from "./trustedHost";
import { seoForRequest } from "./hostSeo";

const SECRET = "synthetic-worker-secret-for-unit-tests-only";
const FALLBACK = "https://learn.flowrad.ai";
const requestHeaders = (values: Record<string, string> = {}): RequestHeaders => ({ get: key => values[key.toLowerCase()] ?? null });
async function configured(run: () => Promise<void>) {
  const keys = ["TRUSTED_PROXY_SECRET", "BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL"];
  const saved = keys.map(key => process.env[key]);
  process.env.TRUSTED_PROXY_SECRET = SECRET;
  process.env.BETTER_AUTH_URL = FALLBACK;
  process.env.NEXT_PUBLIC_APP_URL = "https://must-not-be-used.example";
  try { await run(); }
  finally { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
}

describe("C1 authenticated public origin", { concurrency: 1 }, () => {
  test("valid Worker secret selects the forwarded hostname, always over HTTPS", async () => configured(async () => {
    assert.equal(await trustedPublicOrigin(requestHeaders({
      [PROXY_SECRET_HEADER]: SECRET, "x-forwarded-host": "APP.VIEWER.FLOWRAD.AI",
      host: "upstream.run.app", "x-forwarded-proto": "http",
    })), "https://app.viewer.flowrad.ai");
  }));

  test("missing, wrong, prefix, suffix and different-length secrets cannot select a host", async () => configured(async () => {
    for (const supplied of [undefined, "", "wrong", SECRET.slice(1), SECRET + "x", SECRET + "\u0000", "x" + SECRET.slice(1), SECRET.slice(0, -1) + "x", "é".repeat(SECRET.length), "x".repeat(4097)]) {
      const headers = requestHeaders({ host: "app.viewer.flowrad.ai", "x-forwarded-host": "attacker.example", forwarded: "host=attacker.example", ...(supplied === undefined ? {} : { [PROXY_SECRET_HEADER]: supplied }) });
      assert.equal(await trustedPublicOrigin(headers), FALLBACK);
    }
  }));

  test("unset or empty TRUSTED_PROXY_SECRET never trusts a supplied secret", async () => configured(async () => {
    const headers = requestHeaders({ [PROXY_SECRET_HEADER]: SECRET, "x-forwarded-host": "app.viewer.flowrad.ai" });
    delete process.env.TRUSTED_PROXY_SECRET;
    assert.equal(await trustedPublicOrigin(headers), FALLBACK);
    process.env.TRUSTED_PROXY_SECRET = "";
    assert.equal(await trustedPublicOrigin(headers), FALLBACK);
  }));

  test("a signed request without a forwarded host still uses BETTER_AUTH_URL, not Host", async () => configured(async () => {
    assert.equal(await trustedPublicOrigin(requestHeaders({ [PROXY_SECRET_HEADER]: SECRET, host: "app.viewer.flowrad.ai" })), FALLBACK);
  }));

  test("invalid signed hostnames fail closed: no schemes, ports, paths, lists or injection", async () => configured(async () => {
    const bad = ["", "https://learn.flowrad.ai", "learn.flowrad.ai:443", "learn.flowrad.ai/path", "learn.flowrad.ai?x=1", "learn.flowrad.ai#x", "user@learn.flowrad.ai", "learn.flowrad.ai,evil.example", "learn.flowrad.ai evil.example", " learn.flowrad.ai", "learn.flowrad.ai ", "learn.flowrad.ai\r\nX-Injected: true", "learn.flowrad.ai\u0000", "learn.flowrad.ai\\evil", "learn%2eflowrad.ai", ".learn.flowrad.ai", "learn..flowrad.ai", "learn.flowrad.ai.", "-learn.flowrad.ai", "learn-.flowrad.ai", "learn_flowrad.ai", "éxample.test", "[::1]", "0x7f000001", "127.1", "a".repeat(64) + ".test", ("a".repeat(63) + ".").repeat(4) + "test"];
    for (const host of bad) {
      assert.equal(validForwardedHostname(host), false);
      assert.equal(await trustedPublicOrigin(requestHeaders({ [PROXY_SECRET_HEADER]: SECRET, "x-forwarded-host": host })), FALLBACK);
    }
  }));

  test("hostname validation accepts ordinary DNS labels and ASCII IDNs", () => {
    for (const host of ["learn.flowrad.ai", "APP.VIEWER.FLOWRAD.AI", "worker-1.example", "xn--bcher-kva.example", "localhost"]) assert.equal(validForwardedHostname(host), true);
  });

  test("fallback keeps the configured origin and ignores NEXT_PUBLIC_APP_URL", async () => configured(async () => {
    process.env.BETTER_AUTH_URL = "https://learn.flowrad.ai:8443/configured/path";
    assert.equal(await trustedPublicOrigin(requestHeaders({ host: "upstream.run.app" })), "https://learn.flowrad.ai:8443");
    delete process.env.BETTER_AUTH_URL;
    assert.equal(configuredPublicOrigin(), "http://localhost:3000");
  }));

  test("native crypto verification failure does not grant trust", async t => configured(async () => {
    t.mock.method(crypto.subtle, "verify", async () => { throw new Error("synthetic crypto failure"); });
    assert.equal(await trustedPublicOrigin(requestHeaders({ [PROXY_SECRET_HEADER]: SECRET, "x-forwarded-host": "app.viewer.flowrad.ai" })), FALLBACK);
  }));

  test("secret is absent from console, metadata, robots, sitemap, responses and errors", async t => configured(async () => {
    const logs: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
    const outputs: unknown[] = [];
    for (const supplied of [SECRET, "wrong", ""]) {
      const values = { [PROXY_SECRET_HEADER]: supplied, "x-forwarded-host": "app.viewer.flowrad.ai" };
      outputs.push(await trustedPublicOrigin(requestHeaders(values)), await seoForRequest(requestHeaders(values)));
      const response = await middleware(new NextRequest("https://upstream.run.app/", { headers: values }));
      outputs.push(Object.fromEntries(response.headers), await response.text());
    }
    assert.throws(() => configuredPublicOrigin(`https://user:${SECRET}@learn.flowrad.ai`), error => {
      outputs.push(String(error)); return error instanceof Error;
    });
    assert.equal(JSON.stringify(logs).includes(SECRET), false);
    assert.equal(JSON.stringify(outputs).includes(SECRET), false);
    assert.equal(logs.length, 0);
  }));

  test("robots, sitemap and metadata select the authenticated origin or configured fallback", async () => configured(async () => {
    for (const supplied of [SECRET, "wrong", ""]) {
      const seo = await seoForRequest(requestHeaders({ [PROXY_SECRET_HEADER]: supplied, "x-forwarded-host": "app.viewer.flowrad.ai", host: "upstream.run.app" }));
      const expected = supplied === SECRET ? "https://app.viewer.flowrad.ai" : FALLBACK;
      assert.equal(seo.robots.sitemap, `${expected}/sitemap.xml`);
      assert.ok(seo.sitemap.every(entry => entry.url.startsWith(`${expected}/`)));
      assert.equal(seo.sitemap.length, supplied === SECRET ? 1 : 3);
      assert.equal(seo.metadata.metadataBase?.href, `${expected}/`);
    }
    process.env.BETTER_AUTH_URL = "https://learn.flowrad.ai:8443";
    const seo = await seoForRequest(requestHeaders());
    assert.equal(seo.robots.sitemap, "https://learn.flowrad.ai:8443/sitemap.xml");
    assert.equal(seo.sitemap[0].url, "https://learn.flowrad.ai:8443/");
  }));

  test("unrecognized trusted domains retain the deny-all SEO policy", async () => configured(async () => {
    const seo = await seoForRequest(requestHeaders({ [PROXY_SECRET_HEADER]: SECRET, "x-forwarded-host": "preview.example" }));
    assert.deepEqual(seo.robots, { rules: { userAgent: "*", disallow: "/" } });
    assert.deepEqual(seo.sitemap, []);
  }));

  test("middleware redirects use authenticated origin, never the run.app URL", async () => configured(async () => {
    const response = await middleware(new NextRequest("http://upstream.run.app:8080/?x=1&x=2", { headers: { [PROXY_SECRET_HEADER]: SECRET, "x-forwarded-host": "app.viewer.flowrad.ai" } }));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://app.viewer.flowrad.ai/viewer?x=1&x=2");
    const untrusted = await middleware(new NextRequest("http://upstream.run.app/", { headers: { host: "app.viewer.flowrad.ai", "x-forwarded-host": "app.viewer.flowrad.ai" } }));
    assert.equal(untrusted.headers.get("location"), null);
  }));
});
