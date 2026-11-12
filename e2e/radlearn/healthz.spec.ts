import { expect, test } from "@playwright/test";

test("healthz is public liveness with no environment or service details", async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const response = await anonymous.get("/api/healthz", { headers: { "x-forwarded-host": "untrusted.example", "x-flowrad-proxy-secret": "synthetic-invalid" } });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
    const head = await anonymous.head("/api/healthz");
    expect(head.status()).toBe(200);
    expect(await head.text()).toBe("");
  } finally { await anonymous.dispose(); }
});
