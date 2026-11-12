import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Settings › Scrolling, as the desktop has it: slices per wheel notch,
// browse-drag distance and acceleration, in the free viewer's Help ›
// Customise, applied live to the image and remembered in this browser.
// Synthetic 60-image CT.

const DIR = process.env.TEST_CT_DIR;
const SHOTS = process.env.SCREENSHOT_DIR;

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
const slice = async (page: Page) => Number(await page.getByRole("slider", { name: "Slice" }).first().getAttribute("aria-valuenow"));

async function openStudy(page: Page) {
  const files = fs.readdirSync(DIR!).sort().map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
}

/** One wheel notch down over the image, then the slice it settles on. */
async function notch(page: Page): Promise<number> {
  const box = (await image(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await slice(page);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => slice(page)).not.toBe(before);
  await page.waitForTimeout(300);
  return (await slice(page)) - before;
}

async function openScrolling(page: Page) {
  await image(page).click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Shift+?");
  const sheet = page.getByRole("dialog", { name: /Viewer shortcuts/ });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Customise" }).click();
  const section = page.getByRole("region", { name: "Scrolling" });
  await expect(section).toBeVisible({ timeout: 15_000 });
  return section;
}

test("scroll settings: slices per notch applies to the image, the preview follows, and it is remembered", async ({ page }) => {
  test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await openStudy(page);

  // Default: one slice per notch, as before.
  expect(await notch(page)).toBe(1);

  // Help › Customise › Scrolling: 3 slices per notch, acceleration stays off.
  const section = await openScrolling(page);
  const wheel = section.getByRole("slider", { name: "Mouse wheel" });
  await expect(section).toContainText("1 slice per notch");
  await expect(section.getByRole("slider", { name: "Browse drag" })).toHaveValue("0");
  await expect(section).toContainText("Automatic");
  await expect(section.getByRole("switch", { name: "Acceleration" })).toHaveAttribute("aria-checked", "false");
  await wheel.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(section).toContainText("3 slices per notch");

  // The preview strip moves 3 per notch too.
  const preview = section.getByTestId("scroll-preview");
  const pbox = (await preview.boundingBox())!;
  await page.mouse.move(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
  await page.mouse.wheel(0, 100);
  await expect(preview).toHaveAttribute("aria-valuenow", "64");
  // Browse drag: a fixed distance; the switch turns on.
  await section.getByRole("slider", { name: "Browse drag" }).fill("12");
  await expect(section).toContainText("12 px per slice");
  await section.getByRole("switch", { name: "Acceleration" }).click();
  await expect(section.getByRole("switch", { name: "Acceleration" })).toHaveAttribute("aria-checked", "true");
  await section.getByRole("switch", { name: "Acceleration" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close shortcuts" }).click().catch(() => undefined);
  await expect(page.getByRole("dialog", { name: /Viewer shortcuts|Mouse & keyboard/ })).toHaveCount(0);

  // On the image: one notch, three slices.
  expect(await notch(page)).toBe(3);

  // Remembered in this browser: a reload, the same study, still three.
  await page.reload();
  await openStudy(page);
  expect(await notch(page)).toBe(3);
  const again = await openScrolling(page);
  await expect(again).toContainText("3 slices per notch");
  await expect(again).toContainText("12 px per slice");
  expect(errors).toEqual([]);
});

// The screenshot for people (SCREENSHOT_DIR): sharp at 2×, no wheel needed.
test.describe("screenshot", () => {
  test.use({ deviceScaleFactor: 2 });
  test("scroll settings: screenshot", async ({ page }) => {
    test.skip(!DIR || !SHOTS, "SCREENSHOT_DIR and TEST_CT_DIR are not set");
    test.setTimeout(120_000);
    await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/viewer");
    await openStudy(page);
    const section = await openScrolling(page);
    await section.getByRole("slider", { name: "Mouse wheel" }).fill("3");
    await section.getByRole("slider", { name: "Browse drag" }).fill("12");
    await expect(section).toContainText("3 slices per notch");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS!, "scrolling-settings.png") });
  });
});
