import { expect, test } from "@playwright/test";

test("DICOMweb requires a session before QIDO, metadata or pixel access", async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    for (const path of ["studies", "studies/1.2.3/series", "studies/1.2.3/series/1.2.4/metadata", "studies/1.2.3/series/1.2.4/instances/1.2.5/frames/1"]) {
      expect((await anonymous.get(`/api/dicomweb/${path}`)).status()).toBe(401);
      expect((await anonymous.head(`/api/dicomweb/${path}`)).status()).toBe(401);
    }
    // Ingest stays behind the separate author/de-identification gate.
    expect((await anonymous.post("/api/dicomweb/studies")).status()).toBe(405);
  } finally { await anonymous.dispose(); }
});
