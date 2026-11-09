import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// A series thumbnail's right-click menu, as on the desktop: "Open in a new
// layout pane" grows the layout by one pane and hangs the series there;
// "Open in active pane" replaces what the outlined pane shows. Synthetic
// six-series study.

const MULTI = process.env.TEST_MULTI_DIR;

const thumb = (page: Page, description: string) =>
  page.getByRole("list", { name: "Series" }).getByRole("button").filter({ hasText: description }).first();

test("series thumbnail menu: open in a new layout pane, then in the active pane", async ({ page }) => {
  test.skip(!MULTI, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(MULTI!).map((f) => path.join(MULTI!, f)));
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await expect(page.getByRole("radio", { name: "Single layout" })).toHaveAttribute("aria-checked", "true");

  // Right-click "Axial bone" › Open in a new layout pane: side by side, bone in pane 2.
  await thumb(page, "Axial bone").click({ button: "right" });
  const item = (name: RegExp) => page.locator('[role^="menuitem"]').filter({ hasText: name }).first();
  await item(/Open in a new layout pane/).click();
  await expect(page.getByRole("radio", { name: "Side by side layout" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
  await expect(thumb(page, "Axial bone").getByLabel("In pane 2")).toBeVisible();

  // Right-click "Delayed" › Open in active pane: the new pane (2) is active, so Delayed replaces bone there.
  await thumb(page, "Delayed").click({ button: "right" });
  await item(/Open in active pane/).click();
  await expect(thumb(page, "Delayed").getByLabel("In pane 2")).toBeVisible({ timeout: 15_000 });
  await expect(thumb(page, "Axial bone").getByLabel(/In pane/)).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Side by side layout" })).toHaveAttribute("aria-checked", "true");
  expect(errors).toEqual([]);
});

test("series thumbnail menu: Quick sagittal opens the series reformatted in the active pane", async ({ page }) => {
  test.skip(!MULTI, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(MULTI!).map((f) => path.join(MULTI!, f)));
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  const plane = page.getByTestId("plane-switch").first();
  await expect(plane).toHaveAccessibleName("Plane, Acquired");

  await thumb(page, "Axial bone").click({ button: "right" });
  const item = (name: RegExp) => page.locator('[role^="menuitem"]').filter({ hasText: name }).first();
  await expect(item(/Quick coronal/)).toBeVisible();
  await item(/Quick sagittal/).click();
  // The pane now shows bone (selected in the list), reformatted sagittally.
  await expect(thumb(page, "Axial bone")).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  await expect(plane).toHaveAccessibleName("Plane, Sagittal", { timeout: 30_000 });
  expect(errors).toEqual([]);
});
