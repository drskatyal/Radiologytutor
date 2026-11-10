import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The compact series list, as the desktop's "Compact series list" setting:
// one line per series instead of thumbnails, toggled from the list's heading
// and remembered on this device. Rows keep everything a thumbnail does: pick,
// pane badge, right-click menu. Synthetic six-series study.

const MULTI = process.env.TEST_MULTI_DIR;
const SHOTS = process.env.SCREENSHOT_DIR;
// Screenshots for people (SCREENSHOT_DIR): sharp at 2×.
test.use({ deviceScaleFactor: SHOTS ? 2 : 1 });

const list = (page: Page) => page.getByRole("list", { name: "Series" });
const row = (page: Page, description: string) => list(page).getByRole("button").filter({ hasText: description }).first();
const toggle = (page: Page) => page.getByRole("button", { name: "Compact series list" });

test("compact series list: one line per series, everything a thumbnail does, remembered", async ({ page }) => {
  test.skip(!MULTI, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(MULTI!).sort().map((f) => path.join(MULTI!, f));
  const open = () => page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await open();
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);

  // Thumbnails by default.
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(list(page)).toHaveAttribute("data-compact", "false");
  await expect(list(page).locator("img").first()).toBeVisible({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "thumbnails.png") });

  // Compact: six rows, no thumbnails, each with modality + number, description and image count.
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(list(page)).toHaveAttribute("data-compact", "true");
  await expect(list(page).getByRole("button")).toHaveCount(6);
  await expect(list(page).locator("img")).toHaveCount(0);
  await expect(row(page, "Axial lung")).toContainText(/CT 3\s*Axial lung\s*40/);

  // A row opens its series, as a thumbnail does.
  await row(page, "Axial bone").click();
  await expect(row(page, "Axial bone")).toHaveAttribute("aria-pressed", "true");

  // Side by side: the pane badges show on the rows.
  await page.getByRole("radio", { name: "Side by side layout" }).click();
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
  await expect(list(page).getByLabel("In pane 2")).toHaveCount(1);
  if (SHOTS) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, "compact.png") });
  }

  // The thumbnail menu works on a row too.
  await row(page, "Delayed").click({ button: "right" });
  await expect(page.locator('[role^="menuitem"]').filter({ hasText: /Series info/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  // Remembered on this device: a reload and the same study, still compact.
  await page.reload();
  await open();
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(list(page)).toHaveAttribute("data-compact", "true");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  // Back to thumbnails.
  await toggle(page).click();
  await expect(list(page)).toHaveAttribute("data-compact", "false");
  await expect(list(page).locator("img").first()).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
