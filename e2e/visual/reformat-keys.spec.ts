import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The desktop's reformat and annotate keys in the free viewer:
// Alt+A / C / S reformat this pane (the same key again returns to the
// stack), right-click › Reformat › Axial / Coronal / Sagittal, Shift+E the
// eraser, Ctrl/⌘+Shift+Backspace clears every measurement in one undo
// step. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
const layout = (page: Page) => page.locator('[data-mpr-layout="live"]');
const onImage = (page: Page) => page.getByTestId("annotation-state").evaluate((el: HTMLElement) => Number(el.dataset.onImage));

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 10 });
  await page.mouse.up();
}

test("reformat and annotate keys: Alt+A / C / S, right-click Reformat, Shift+E eraser, Ctrl+Shift+Backspace clear", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(DIR!).map((f) => path.join(DIR!, f)));
  const slider = page.getByRole("slider", { name: "Slice" }).first();
  await expect(slider).toBeVisible({ timeout: 30_000 });
  await page.waitForSelector('[data-testid="annotation-state"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(800);

  // Alt+C: a coronal reformat fills this pane; Alt+C again is the stack.
  await image(page).focus();
  await page.keyboard.press("Alt+c");
  await expect(layout(page)).toBeVisible({ timeout: 30_000 });
  await expect(layout(page)).toHaveAttribute("data-mpr-maximized", "coronal");
  await expect(page.getByText(/Coronal reformat/).first()).toBeVisible();
  await page.keyboard.press("Alt+c");
  await expect(layout(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(slider).toBeVisible();

  // Right-click › Reformat › Sagittal (showing Alt+S); Alt+A from there goes to axial.
  const b = (await image(page).boundingBox())!;
  const P = (fx: number, fy: number): [number, number] => [b.x + b.width * fx, b.y + b.height * fy];
  await page.mouse.click(...P(0.15, 0.15), { button: "right" });
  await page.getByRole("menu", { name: "Image" }).getByRole("menuitem", { name: /^Reformat/ }).hover();
  const sagittal = page.getByRole("menuitemradio", { name: /^Sagittal/ });
  await expect(sagittal.locator("kbd")).toContainText("S");
  await sagittal.click();
  await expect(layout(page)).toHaveAttribute("data-mpr-maximized", "sagittal", { timeout: 30_000 });
  await page.keyboard.press("Alt+a");
  await expect(layout(page)).toHaveAttribute("data-mpr-maximized", "axial");
  await page.keyboard.press("Alt+a");
  await expect(layout(page)).toHaveCount(0, { timeout: 10_000 });

  // Two measurements, then Ctrl+Shift+Backspace clears both in one step; Ctrl+Z brings both back.
  await image(page).focus();
  await page.keyboard.press("l");
  await drag(page, P(0.3, 0.5), P(0.6, 0.5));
  await page.keyboard.press("e");
  await drag(page, P(0.42, 0.25), P(0.52, 0.35));
  await expect.poll(() => onImage(page)).toBe(2);
  await image(page).focus();
  await page.keyboard.press("Control+Shift+Backspace");
  await expect(page.getByText("2 measurements cleared · Ctrl+Z to undo").first()).toBeVisible();
  await expect.poll(() => onImage(page)).toBe(0);
  await page.keyboard.press("Control+z");
  await expect.poll(() => onImage(page)).toBe(2);

  // Shift+E: the eraser; a click on the length deletes it.
  await image(page).focus();
  await page.keyboard.press("Shift+E");
  await expect(page.getByText("Eraser").first()).toBeVisible();
  await page.mouse.click(...P(0.45, 0.5));
  await expect.poll(() => onImage(page)).toBe(1);

  // The help sheet lists them.
  await image(page).focus();
  await page.keyboard.press("Shift+?");
  const help = page.getByRole("dialog");
  await expect(help.getByText(/^Reformat this pane/)).toBeVisible();
  await expect(help.getByText(/^Clear all measurements/)).toBeVisible();
  expect(errors).toEqual([]);
});
