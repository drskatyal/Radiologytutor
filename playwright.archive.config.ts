import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { ARCHIVE_STORAGE_STATE } from "./e2e/support/archiveSignIn";

// Archive-backed e2e (e2e/archive): RadLearn screens that read series from an
// archive, e.g. the case viewer. Kept apart from the visual gate
// (playwright.visual.config.ts), which needs no backend and runs with no
// demo sign-in, no archive and the default data dir.
//
// Here a stand-in Orthanc (e2e/support/mockArchive.mjs: Orthanc REST + the
// bench DICOMweb origin) starts first and seeds a temp data dir with /seed
// plus one archive case; the app (a production build: `npm run build` first)
// reads both, with demo sign-in on because pixel reads are gated on a
// session (lib/studyAccess).
//
//   npx playwright test -c playwright.archive.config.ts --workers=1
const PORT = Number(process.env.ARCHIVE_E2E_PORT ?? 3102);
const MOCK_ARCHIVE_PORT = Number(process.env.MOCK_ARCHIVE_PORT ?? 3199);
const MOCK_ARCHIVE_DATA_DIR = path.join(os.tmpdir(), "flowrad-e2e-archive-data");

export default defineConfig({
  testDir: "e2e/archive",
  // One demo sign-in for the suite (the route is rate limited); see the setup.
  globalSetup: "./e2e/support/archiveSignIn.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    baseURL: `http://127.0.0.1:${PORT}`,
    storageState: ARCHIVE_STORAGE_STATE,
    // Sandboxes that ship their own Chromium (not the pinned build) set this.
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH, args: ["--headless", "--no-sandbox"] } }
      : {}),
  },
  webServer: [
    {
      command: `node e2e/support/mockArchive.mjs`,
      url: `http://127.0.0.1:${MOCK_ARCHIVE_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { MOCK_ARCHIVE_PORT: String(MOCK_ARCHIVE_PORT), MOCK_ARCHIVE_DATA_DIR },
    },
    {
      command: `npx next start -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}/viewer/local`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        // Throwaway: this run has no real accounts.
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "archive-e2e-only-not-a-real-secret-0000",
        ORTHANC_URL: `http://127.0.0.1:${MOCK_ARCHIVE_PORT}`,
        DATA_DIR: MOCK_ARCHIVE_DATA_DIR,
        DEMO_AUTH_ENABLED: "1",
      },
    },
  ],
});
