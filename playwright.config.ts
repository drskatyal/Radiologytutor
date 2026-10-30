import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "curl -sf -o /dev/null http://127.0.0.1:8042/studies/study-lidc || python3 scripts/serve_local_ct.py & exec npm run dev",
    url: "http://127.0.0.1:3000/case/case-lidc-nodule-search",
    reuseExistingServer: true,
    timeout: 180_000,
    env: {
      ORTHANC_URL: "http://127.0.0.1:8042",
      ORTHANC_USER: "flowrad",
      ORTHANC_PASSWORD: "local",
    },
  },
});
