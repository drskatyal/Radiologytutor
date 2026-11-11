import { defineConfig } from "@playwright/test";
import path from "node:path";
import archive from "./playwright.archive.config";

// Local, synthetic-only data. Reuses the archive harness and its demo session.
const dataDir = path.join(process.cwd(), ".radlearn-tmp", "radlearn-data");
export default defineConfig({
  ...archive,
  testDir: "e2e/radlearn",
  workers: 1,
  webServer: (Array.isArray(archive.webServer) ? archive.webServer : []).map(server => ({
    ...server,
    reuseExistingServer: false,
    env: { ...server.env, BETTER_AUTH_URL: "http://127.0.0.1:3102", RADLEARN_SYNTHETIC: "1", MOCK_ARCHIVE_DATA_DIR: dataDir, DATA_DIR: dataDir },
  })),
});
