import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Voice commands with the microphone refused: the panel says why and offers
// Retry, instead of a spinner that never ends. Its own file because the
// browser flags differ from voice.spec.ts (Playwright only takes launch
// options per file).

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

// No fake-UI flag and no granted permission: getUserMedia is refused.
test.use({
  permissions: [],
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: ["--no-sandbox", "--deny-permission-prompts"],
  },
});

async function openStudy(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer/local");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await page.waitForSelector('[data-testid="annotation-state"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(1000);
}

test("voice: a blocked microphone says so, with Retry, instead of spinning", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await openStudy(page);
  await page.getByRole("button", { name: /^Voice commands/ }).click();
  const status = page.getByTestId("voice-status");
  await expect(status).toContainText(/Microphone access is blocked|No microphone found/, { timeout: 30_000 });
  await expect(status.getByRole("button", { name: "Retry" })).toBeVisible();
  await status.getByRole("button", { name: "Dismiss" }).click();
  await expect(status).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Voice commands$/ })).toBeVisible();
});
