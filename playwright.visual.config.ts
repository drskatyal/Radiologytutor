import { defineConfig } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// PLUGIN_E2E=1 turns the viewer plugin host on with a TEST FIXTURE plugin
// (e2e/fixtures/plugins), served by a Playwright route in plugins.spec.ts.
// Off by default so the other specs see the viewer exactly as shipped.
const pluginEnv: Record<string, string> = process.env.PLUGIN_E2E
  ? {
      VIEWER_PLUGINS_ENABLED: "1",
      VIEWER_PLUGINS: JSON.stringify([
        {
          id: "e2e-demo",
          url: "/__e2e/plugins/e2e-demo-plugin.js",
          sha256: createHash("sha256").update(readFileSync("e2e/fixtures/plugins/e2e-demo-plugin.js")).digest("hex"),
        },
      ]),
    }
  : {};

// Visual-regression + perf gate for the web viewer (e2e/visual). Runs against a
// production build (`npm run build` first) of the free /viewer, which needs no
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
    url: `http://127.0.0.1:${PORT}/viewer`,
    reuseExistingServer: !process.env.CI,
    // Fail fast with a clear message rather than hang a CI job on one step.
  timeout: 60_000,
    // The session module refuses to serve without a signing secret; this run
    // has no accounts, so a throwaway one is fine.
    env: { SESSION_SECRET: process.env.SESSION_SECRET ?? "visual-regression-only-not-a-real-secret", ...pluginEnv },
  },
});
