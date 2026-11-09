import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The scale bar, as the desktop's "Scale bar" setting draws it: a calibrated
// ruler along the bottom of the image, a round length that follows the zoom.
// On the free viewer it is a checked item on the image menu, remembered in
// this browser. Synthetic CT: 512 × 512 at 0.68359375 mm per pixel.

const DIR = process.env.TEST_CT_DIR;
const SPACING = 0.68359375;

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
const bar = (page: Page) => page.getByTestId("scale-bar");
const menuItem = (page: Page, name: RegExp) => page.locator('[role^="menuitem"]').filter({ hasText: name }).first();

async function rightClick(page: Page) {
  const box = (await image(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3, { button: "right" });
  await expect(page.getByRole("menu", { name: "Image" })).toBeVisible();
}

/** The ruler's length (mm) and its drawn width (CSS px). */
async function ruler(page: Page) {
  const mm = Number(await bar(page).getAttribute("data-mm"));
  const svgWidth = Number(await bar(page).locator("svg").getAttribute("width"));
  return { mm, px: svgWidth - 2 };
}

test("scale bar: from the image menu, calibrated at 100 % and 800 %, remembered, then off", async ({ page }) => {
  test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).sort().map((f) => path.join(DIR!, f));
  const open = () => page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await open();
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);

  // Off by default, as on the desktop; the menu offers it unchecked.
  await expect(bar(page)).toHaveCount(0);
  await rightClick(page);
  await expect(page.getByRole("menuitemradio", { name: /Scale bar/ })).toHaveAttribute("aria-checked", "false");
  await menuItem(page, /Scale bar/).click();
  await expect(bar(page)).toBeVisible();

  // 100 %: one image pixel per screen pixel, so the ruler is its length / 0.684 mm wide.
  await image(page).focus();
  await page.keyboard.press("Control+1");
  await expect.poll(async () => {
    const r = await ruler(page);
    return Math.abs(r.px - r.mm / SPACING);
  }).toBeLessThan(1.5);
  const at100 = await ruler(page);
  expect(at100.mm).toBeGreaterThanOrEqual(50);
  await expect(bar(page)).toContainText(/^\d+ cm$/);

  // 800 %: a shorter round length, still calibrated (8 screen pixels per image pixel).
  await page.keyboard.press("Control+4");
  await expect.poll(async () => (await ruler(page)).mm).toBeLessThan(at100.mm);
  await expect.poll(async () => {
    const r = await ruler(page);
    return Math.abs(r.px - (8 * r.mm) / SPACING);
  }).toBeLessThan(1.5);

  // Remembered in this browser: a reload and the same study, still on.
  await page.reload();
  await open();
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(bar(page)).toBeVisible({ timeout: 10_000 });

  // Off again from the menu (checked now).
  await page.waitForTimeout(500);
  await rightClick(page);
  await expect(page.getByRole("menuitemradio", { name: /Scale bar/ })).toHaveAttribute("aria-checked", "true");
  await menuItem(page, /Scale bar/).click();
  await expect(bar(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
