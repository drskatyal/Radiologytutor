import { defineConfig } from "@playwright/test";

// Visual-regression + perf gate for the web viewer (e2e/visual). Runs against a
// production build (`npm run build` first) of /viewer/local, which needs no
// backend: the study is local files (scripts/make-test-ct.py → TEST_CT_DIR).
const PORT = Number(process.env.VISUAL_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e/visual",
  // Fail fast with a clear message rather than hang a CI job on one step.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    baseURL: `http://127.0.0.1:${PORT}`,
    // Sandboxes that ship their own Chromium (not the pinned build) set this.
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH, args: ["--headless", "--no-sandbox"] } }
      : {}),
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/viewer/local`,
    reuseExistingServer: !process.env.CI,
    // Fail fast with a clear message rather than hang a CI job on one step.
  timeout: 60_000,
    // The auth module refuses to serve without a signing secret; this run has
    // no accounts, so a throwaway one is fine.
    env: { BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "visual-regression-only-not-a-real-secret" },
  },
});
