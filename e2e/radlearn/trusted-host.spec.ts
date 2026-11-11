import { expect, test } from "@playwright/test";

// Intentionally public dummy, configured only by playwright.radlearn.config.ts.
const secret = "synthetic-worker-secret-for-local-tests-only";
const trusted = { "x-flowrad-proxy-secret": secret, "x-forwarded-host": "learn.flowrad.ai" };

test("Worker-authenticated robots and sitemap use the forwarded public origin", async ({ request }) => {
  const robots = await request.get("/robots.txt", { headers: trusted });
  expect(robots.ok()).toBeTruthy();
  expect(await robots.text()).toContain("Sitemap: https://learn.flowrad.ai/sitemap.xml");
  const sitemap = await request.get("/sitemap.xml", { headers: trusted });
  expect(sitemap.ok()).toBeTruthy();
  expect(await sitemap.text()).toContain("<loc>https://learn.flowrad.ai/</loc>");
  expect(await sitemap.text()).not.toContain(secret);
});

test("unsigned, wrong-secret and malformed-host requests use configured localhost SEO", async ({ request }) => {
  const candidates: Record<string, string>[] = [
    { "x-forwarded-host": "learn.flowrad.ai" },
    { ...trusted, "x-flowrad-proxy-secret": "wrong" },
    { ...trusted, "x-forwarded-host": "learn.flowrad.ai/evil" },
    { host: "learn.flowrad.ai" },
  ];
  for (const headers of candidates) {
    const robots = await request.get("/robots.txt", { headers });
    expect(await robots.text()).toContain("Disallow: /");
    expect(await robots.text()).not.toContain("Sitemap:");
    const sitemap = await request.get("/sitemap.xml", { headers });
    expect(await sitemap.text()).not.toContain("<loc>");
  }
});

test("landing, layout and viewer metadata use the authenticated or configured origin", async ({ request }) => {
  const landing = await request.get("/", { headers: trusted, maxRedirects: 0 });
  expect(landing.status()).toBe(200);
  expect(await landing.text()).toContain("https://learn.flowrad.ai/opengraph-image");
  expect(await landing.text()).not.toContain(secret);
  const viewer = await request.get("/viewer", { headers: { ...trusted, "x-forwarded-host": "app.viewer.flowrad.ai" }, maxRedirects: 0 });
  expect(viewer.status()).toBe(200);
  expect(await viewer.text()).toContain('rel="canonical" href="https://app.viewer.flowrad.ai/viewer"');
  const untrusted = await request.get("/viewer", { headers: { "x-forwarded-host": "attacker.example" }, maxRedirects: 0 });
  expect(untrusted.status()).toBe(200);
  expect(await untrusted.text()).toContain('rel="canonical" href="http://127.0.0.1:3102/viewer"');
  expect(await untrusted.text()).not.toContain("attacker.example");
});

test("middleware uses Worker host and never redirects back to the upstream origin", async ({ request }) => {
  const viewer = await request.get("/?x=1", { headers: { ...trusted, "x-forwarded-host": "app.viewer.flowrad.ai" }, maxRedirects: 0 });
  expect(viewer.status()).toBe(302);
  expect(viewer.headers().location).toBe("https://app.viewer.flowrad.ai/viewer?x=1");
  expect(JSON.stringify(viewer.headers())).not.toContain(secret);
  const learn = await request.get("/viewer?x=2", { headers: trusted, maxRedirects: 0 });
  expect(learn.status()).toBe(301);
  expect(learn.headers().location).toBe("https://app.viewer.flowrad.ai/viewer?x=2");
  const untrusted = await request.get("/", { headers: { host: "app.viewer.flowrad.ai", "x-forwarded-host": "app.viewer.flowrad.ai" }, maxRedirects: 0 });
  expect(untrusted.status()).toBe(200);
  expect(untrusted.headers().location).toBeUndefined();
});
