import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Distraction-free reading on the free viewer (desktop parity: Alt+Shift+Enter):
// the images fill the window, with no toolbar, series panel or page chrome; a
// hint says how to leave; Esc or the same keys bring everything back. Also in
// the right-click menu (checked while on) and the help sheet. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

const stage = (page: Page) => page.getByTestId("local-stage");
const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
const exportButton = (page: Page) => page.getByRole("button", { name: "Export images, video or DICOM" });

test("distraction-free: images only, hint, Esc and Alt+Shift+Enter leave, menu and help", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(DIR!).map((f) => path.join(DIR!, f)));
  const slider = page.getByRole("slider", { name: "Slice" }).first();
  await expect(slider).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
  await expect(exportButton(page)).toBeVisible();

  // On: the stage covers the window and the toolbar is gone.
  await image(page).focus();
  await page.keyboard.press("Alt+Shift+Enter");
  await expect(stage(page)).toHaveAttribute("data-distraction-free", "true");
  await expect(exportButton(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Distraction-free reading" })).toBeVisible();
  const box = (await stage(page).boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.y).toBe(0);
  expect(box.width).toBe(1440);
  expect(box.height).toBe(900);
  // Reading still works: the keyboard scrolls.
  const before = Number(await slider.getAttribute("aria-valuenow"));
  await image(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(slider).toHaveAttribute("aria-valuenow", String(before + 1));

  // Esc leaves.
  await page.keyboard.press("Escape");
  await expect(stage(page)).not.toHaveAttribute("data-distraction-free", "true");
  await expect(exportButton(page)).toBeVisible();

  // The right-click menu turns it on (and shows it checked), Alt+Shift+Enter turns it off.
  const canvas = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.2, { button: "right" });
  const item = page.getByRole("menu", { name: "Image" }).getByRole("menuitemradio", { name: /^Distraction-free reading/ });
  await expect(item).toHaveAttribute("aria-checked", "false");
  await item.click();
  await expect(stage(page)).toHaveAttribute("data-distraction-free", "true");
  await page.mouse.click(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.2, { button: "right" });
  await expect(page.getByRole("menu", { name: "Image" }).getByRole("menuitemradio", { name: /^Distraction-free reading/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape"); // closes the menu only
  await expect(stage(page)).toHaveAttribute("data-distraction-free", "true");
  await image(page).focus();
  await page.keyboard.press("Alt+Shift+Enter");
  await expect(stage(page)).not.toHaveAttribute("data-distraction-free", "true");

  // Listed in the help sheet.
  await image(page).focus();
  await page.keyboard.press("Shift+?");
  await expect(page.getByRole("dialog")).toContainText("Distraction-free reading");

  expect(errors).toEqual([]);
});
