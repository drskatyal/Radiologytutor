import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Slabs on the free viewer (desktop parity): T cycles thin → MIP → MinIP →
// AvgIP on the stack's own plane, reformatted in this viewport; Ctrl+] / [
// change the thickness; the right-click Slab menu and the toolbar's MIP
// agree; cycling back to a thin slice returns to the stack. Synthetic CT.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
const layout = (page: Page) => page.locator('[data-mpr-layout="live"]');
const badge = (page: Page) => page.locator('[data-mpr-plane="axial"] [data-mpr-slab]');

/** A fingerprint of the axial plane's pixels (sum of a coarse grid). */
async function axialPixels(page: Page): Promise<number> {
  return page.locator('[data-mpr-plane="axial"] canvas').first().evaluate((c: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = 64;
    copy.height = 64;
    const ctx = copy.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i]!;
    return sum;
  });
}

test("slab: T cycles MIP / MinIP / AvgIP on the stack's plane, Ctrl+] thicker, menu, back to the stack", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(DIR!).map((f) => path.join(DIR!, f)));
  const slider = page.getByRole("slider", { name: "Slice" }).first();
  await expect(slider).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);

  // T: MIP 10 mm on the axial plane (the stack's), enlarged in this viewport.
  await image(page).focus();
  await page.keyboard.press("t");
  await expect(layout(page)).toBeVisible({ timeout: 30_000 });
  await expect(layout(page)).toHaveAttribute("data-mpr-maximized", "axial");
  await expect(badge(page)).toHaveText("MIP 10 mm");
  await page.waitForTimeout(1500);
  const mip = await axialPixels(page);

  // Ctrl+] thicker.
  await page.keyboard.press("Control+]");
  await expect(badge(page)).toHaveText("MIP 12 mm");

  // MinIP, then AvgIP: each draws differently.
  await page.keyboard.press("t");
  await expect(badge(page)).toHaveText("MinIP 12 mm");
  await page.waitForTimeout(800);
  const minip = await axialPixels(page);
  expect(minip).not.toBe(mip);
  await page.keyboard.press("t");
  await expect(badge(page)).toHaveText("AvgIP 12 mm");

  // T once more: a thin slice, back on the stack.
  await page.keyboard.press("t");
  await expect(layout(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(slider).toBeVisible();

  // The right-click Slab menu (on the stack) starts one at a chosen thickness.
  const canvas = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.2, { button: "right" });
  await page.getByRole("menu", { name: "Image" }).getByRole("menuitem", { name: /^Slab/ }).hover();
  await expect(page.getByRole("menuitemradio", { name: /^Thin \(single slice\)/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: /^20 mm/ }).press("Enter");
  await expect(badge(page)).toHaveText("MIP 20 mm", { timeout: 30_000 });
  await page.keyboard.press("t");
  await page.keyboard.press("t");
  await page.keyboard.press("t");
  await expect(layout(page)).toHaveCount(0, { timeout: 10_000 });

  // The toolbar's MIP is the same slab (15 mm when none was set).
  await page.getByRole("radio", { name: "MIP" }).click();
  await expect(badge(page)).toHaveText("MIP 15 mm", { timeout: 30_000 });

  expect(errors).toEqual([]);
});
