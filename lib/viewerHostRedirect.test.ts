import { test } from "node:test";
import assert from "node:assert/strict";
import { learnViewerRedirect, viewerHostRedirect } from "./viewerHostRedirect";

class TestUrl extends URL {
  clone(): TestUrl {
    return new TestUrl(this.href);
  }
}

test("viewer host root redirects temporarily and preserves the original URL", () => {
  const original = new TestUrl("https://app.viewer.flowrad.ai/");
  const result = viewerHostRedirect(original.host, original);
  assert.equal(result?.status, 302);
  assert.equal(result?.url.href, "https://app.viewer.flowrad.ai/viewer");
  assert.equal(original.pathname, "/");
});

for (const path of ["/viewer", "/viewer/local", "/foo"]) {
  test(`viewer host ${path} does not redirect`, () => {
    assert.equal(viewerHostRedirect("app.viewer.flowrad.ai", new TestUrl(`https://app.viewer.flowrad.ai${path}`)), null);
  });
}

for (const host of ["learn.flowrad.ai", "localhost:3000", "flowrad.ai", "example.com", "app.viewer.flowrad.ai.example.com", null]) {
  test(`${host} root does not redirect`, () => {
    assert.equal(viewerHostRedirect(host, new TestUrl("https://example.com/")), null);
  });
}

test("query string is preserved", () => {
  const result = viewerHostRedirect("app.viewer.flowrad.ai", new TestUrl("https://app.viewer.flowrad.ai/?x=1"));
  assert.equal(result?.url.href, "https://app.viewer.flowrad.ai/viewer?x=1");
});

for (const host of ["app.viewer.flowrad.ai:443", "APP.VIEWER.FLOWRAD.AI"]) {
  test(`${host} matches`, () => {
    const result = viewerHostRedirect(host, new TestUrl("https://app.viewer.flowrad.ai/"));
    assert.equal(result?.status, 302);
    assert.equal(result?.url.pathname, "/viewer");
  });
}

for (const host of ["learn.flowrad.ai", "LEARN.FLOWRAD.AI:443"]) {
  test(`${host} viewer permanently redirects with query intact`, () => {
    const original = new TestUrl("http://learn.flowrad.ai/viewer?x=1&x=2&name=a%20b");
    const result = learnViewerRedirect(host, original);
    assert.equal(result?.status, 301);
    assert.equal(result?.url.href, "https://app.viewer.flowrad.ai/viewer?x=1&x=2&name=a%20b");
    assert.equal(original.hostname, "learn.flowrad.ai");
  });
}

for (const host of ["learn.flowrad.ai", "app.viewer.flowrad.ai", "localhost:3000", "example.com", "learn.flowrad.ai.example.com", null]) {
  for (const path of ["/", "/viewer", "/viewer/local", "/viewer/"]) {
    if (host === "learn.flowrad.ai" && path === "/viewer") continue;
    test(`learn redirect leaves ${host} ${path} unchanged`, () => {
      assert.equal(learnViewerRedirect(host, new TestUrl(`https://example.com${path}`)), null);
    });
  }
}
