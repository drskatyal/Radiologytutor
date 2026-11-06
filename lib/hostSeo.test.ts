import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_SEARCH_CRAWLERS, learnMetadataForHost, normalizeHost, robotsForHost, sitemapForHost } from "./hostSeo";

for (const host of ["learn.flowrad.ai", "app.viewer.flowrad.ai"]) {
  test(`${host} allows public discovery and restricts private routes for every crawler`, () => {
    const robots = robotsForHost(host);
    assert.equal(robots.sitemap, `https://${host}/sitemap.xml`);
    assert.ok(Array.isArray(robots.rules));
    assert.deepEqual(robots.rules.map((rule) => rule.userAgent), ["*", ...AI_SEARCH_CRAWLERS]);
    for (const rule of robots.rules) {
      assert.equal(rule.allow, "/");
      for (const path of ["/api/", "/admin", "/author", "/studio", "/dashboard", "/sign-in", "/sign-up", "/s/", "/record", "/dev", "/case/", "/upload", "/learning", "/library", "/course/", "/playlist/", "/certificate/", "/cornerstone", "/viewer/local"]) {
        assert.ok(rule.disallow?.includes(path), `${rule.userAgent}: ${path}`);
      }
      assert.ok(!rule.disallow?.includes("/"));
      assert.ok(!rule.disallow?.includes("/viewer"));
    }
  });
}

test("learn sitemap contains only verified public marketing/legal pages", () => {
  const urls = sitemapForHost("LEARN.FLOWRAD.AI:443").map((entry) => entry.url);
  assert.deepEqual(urls, ["https://learn.flowrad.ai/", "https://learn.flowrad.ai/privacy", "https://learn.flowrad.ai/terms"]);
  assert.ok(urls.every((url) => !/\/(viewer|api|case|s)(\/|$)/.test(new URL(url).pathname)));
});

test("viewer sitemap has only the canonical viewer", () => {
  assert.deepEqual(sitemapForHost("APP.VIEWER.FLOWRAD.AI:443"), [{ url: "https://app.viewer.flowrad.ai/viewer" }]);
});

for (const host of ["localhost:3000", "example.com", "learn.flowrad.ai.evil.test", null]) {
  test(`${host} does not advertise public URLs`, () => {
    assert.deepEqual(robotsForHost(host), { rules: { userAgent: "*", disallow: "/" } });
    assert.deepEqual(sitemapForHost(host), []);
    assert.equal(learnMetadataForHost(host).metadataBase, undefined);
  });
}

test("metadata uses the recognized request host", () => {
  assert.equal(normalizeHost("LEARN.FLOWRAD.AI:3000"), "learn.flowrad.ai");
  const learn = learnMetadataForHost("LEARN.FLOWRAD.AI:443");
  assert.equal(learn.title, "RadLearn by FlowRad");
  assert.equal(learn.metadataBase?.href, "https://learn.flowrad.ai/");
  assert.deepEqual(learn.openGraph?.images, ["https://learn.flowrad.ai/opengraph-image"]);
  const viewer = learnMetadataForHost("app.viewer.flowrad.ai");
  assert.equal(viewer.metadataBase?.href, "https://app.viewer.flowrad.ai/");
  assert.deepEqual(viewer.openGraph?.images, ["https://app.viewer.flowrad.ai/opengraph-image"]);
});
