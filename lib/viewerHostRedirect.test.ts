import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerHostRedirect } from "./viewerHostRedirect";

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
