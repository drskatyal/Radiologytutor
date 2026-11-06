import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer (/viewer, reading room): series thumbnails, rotate / flip with
// edge letters that follow the image, and the collapsible series panel.
// Data: a synthetic multi-series CT (TEST_MULTI_DIR, or TEST_CT_DIR for one
// series). Public / synthetic only.

const DIR = process.env.TEST_MULTI_DIR ?? process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_MULTI_DIR / TEST_CT_DIR is not set (scripts/make-test-ct.py)");
const SHOTS = process.env.SHOT_DIR;

async function open(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const edges = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const el of document.querySelectorAll<HTMLElement>("[data-edge]")) out[el.dataset.edge!] = el.textContent ?? "";
    return out;
  });

test("series thumbnails: real images, lazily, after the first image", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const panel = page.getByRole("complementary", { name: "Series" });
  await expect(panel).toBeVisible();
  const cards = panel.locator("[data-thumb-state]");
  const total = await cards.count();
  expect(total).toBeGreaterThan(0);
  await expect.poll(() => panel.locator("[data-thumb-state=ready]").count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(Math.min(total, 4));
  // Real pixels (a windowed CT slice), not a blank or a placeholder.
  const stats = await panel.locator("[data-thumb-state=ready] img").first().evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      min = Math.min(min, d[i]!);
      max = Math.max(max, d[i]!);
    }
    return { w: img.naturalWidth, min, max };
  });
  expect(stats.w).toBeGreaterThanOrEqual(64);
  expect(stats.max - stats.min, "thumbnail has contrast").toBeGreaterThan(60);
  // Each card names the series: number · modality · image count, description.
  await expect(panel.getByRole("button").filter({ hasText: /#\d+ · CT/ }).first()).toContainText(/\d+ im/);
  // Thumbnail memory is counted (numbers only).
  const held = await page.evaluate(async () => (await (window as unknown as { __flowradViewerStats?: () => Promise<{ maxCacheBytes: number }> }).__flowradViewerStats?.())?.maxCacheBytes ?? 0);
  expect(held).toBeGreaterThan(0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "web-thumbnails.png") });
});

test("rotate / flip: toolbar dropdown, keys, menu; edge letters follow", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.waitForTimeout(500);
  const start = await edges(page);
  expect(start).toEqual({ top: "A", bottom: "P", left: "R", right: "L" });

  // Keyboard: R rotates 90° clockwise — the right edge (L) goes to the bottom.
  await page.locator("canvas").first().click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("r");
  await expect.poll(() => edges(page)).toEqual({ top: "R", bottom: "L", left: "P", right: "A" });
  await page.keyboard.press("Shift+R");
  await expect.poll(() => edges(page)).toEqual(start);
  // H mirrors the screen left ↔ right.
  await page.keyboard.press("h");
  await expect.poll(() => edges(page)).toEqual({ top: "A", bottom: "P", left: "L", right: "R" });

  // Toolbar dropdown: Rotate 180°, then Reset orientation.
  await page.getByRole("button", { name: "Rotate and flip" }).click();
  await page.getByRole("menuitemradio", { name: /Rotate 180°/ }).click();
  await expect.poll(() => edges(page)).toEqual({ top: "P", bottom: "A", left: "R", right: "L" });
  if (SHOTS) {
    await page.getByRole("button", { name: "Rotate and flip" }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, "web-rotate-menu.png") });
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "Rotate and flip" }).click();
  await page.getByRole("menuitemradio", { name: /Reset orientation/ }).click();
  await expect.poll(() => edges(page)).toEqual(start);

  // Right-click → Rotate / flip → Flip vertical.
  const box = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3, { button: "right" });
  await page.getByRole("menuitem", { name: /^Rotate \/ flip/ }).hover();
  await page.getByRole("menuitemradio", { name: /^Flip vertical/ }).click();
  await expect.poll(() => edges(page)).toEqual({ top: "P", bottom: "A", left: "R", right: "L" });
  // Reset view clears the orientation too.
  await page.locator("canvas").first().click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("Backspace");
  await expect.poll(() => edges(page)).toEqual(start);
});

test("series panel: chevron, Ctrl+B, menu, remembered; the image is not reloaded", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const panel = page.getByRole("complementary", { name: "Series" });
  const canvas = page.locator("canvas").first();
  const w0 = (await canvas.boundingBox())!.width;
  // The engine's decoded cache: re-layout must not decode anything again.
  const cacheBytes = () =>
    page.evaluate(async () => (await (window as unknown as { __flowradViewerStats: () => Promise<{ cacheBytes: number }> }).__flowradViewerStats()).cacheBytes);
  await page.waitForTimeout(1500);
  const before = await cacheBytes();

  await page.getByRole("button", { name: "Hide series panel" }).click();
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(w0 + 150);
  if (SHOTS) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, "web-panel-collapsed.png") });
  }
  // Remembered on this device.
  expect(await page.evaluate(() => localStorage.getItem("flowrad.seriesPanel.collapsed"))).toBe("1");

  // Ctrl+B brings it back; the rail's handle and the menu do the same.
  await page.keyboard.press("Control+b");
  await expect(panel).not.toHaveAttribute("data-collapsed", "true");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3, { button: "right" });
  await page.getByRole("menuitemradio", { name: "Hide series panel" }).click();
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await page.getByRole("button", { name: "Show series panel" }).click();
  await expect(panel).not.toHaveAttribute("data-collapsed", "true");
  // The image stayed on screen through every re-layout (no reload).
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible();
  expect(await cacheBytes(), "no image decoded again by the re-layout").toBe(before);

  // Reload: the collapsed choice comes back.
  await page.keyboard.press("Control+b");
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await open(page);
  await expect(page.getByRole("complementary", { name: "Series" })).toHaveAttribute("data-collapsed", "true");
});

// pydicom's own samples (CT_small: rescaled CT with no Window Center/Width;
// MR_small: a second study). HP report 0.8.1: the MR was "silently dropped"
// (its study hid behind a study picker) and the CT thumbnail was black (the
// engine's stored-value default window applied to HU). TEST_PYDICOM_DIR is
// made in CI from pydicom.data.get_testdata_file.
const PYD = process.env.TEST_PYDICOM_DIR;
test.describe("pydicom samples", () => {
  test.skip(!PYD, "TEST_PYDICOM_DIR is not set");
  test("two files of two studies: both listed, both thumbnails real images with no interaction", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
    await page.goto("/viewer");
    const consent = page.getByRole("button", { name: "Continue" });
    if (await consent.count()) await consent.first().click();
    const files = fs.readdirSync(PYD!).map((f) => path.join(PYD!, f));
    expect(files.length).toBe(2);
    await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
    const panel = page.getByRole("complementary", { name: "Series" });
    await expect(panel).toContainText("2 studies", { timeout: 30_000 });
    await expect(panel.getByRole("button").filter({ hasText: /· CT/ })).toHaveCount(1);
    await expect(panel.getByRole("button").filter({ hasText: /· MR/ })).toHaveCount(1);
    // No click, scroll or key after the drop: thumbnails must fill in on their own.
    await expect.poll(() => panel.locator("[data-thumb-state=ready]").count(), { timeout: 20_000 }).toBe(2);
    const contrast = await panel.locator("[data-thumb-state=ready] img").evaluateAll(async (imgs) =>
      Promise.all(
        (imgs as HTMLImageElement[]).map(async (img) => {
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          let max = 0;
          for (let i = 0; i < d.length; i += 4) {
            sum += d[i]!;
            max = Math.max(max, d[i]!);
          }
          return { mean: sum / (d.length / 4), max };
        })
      )
    );
    for (const c of contrast) {
      expect(c.max, `thumbnail is not black (${JSON.stringify(contrast)})`).toBeGreaterThan(150);
      expect(c.mean, `thumbnail is not near-black (${JSON.stringify(contrast)})`).toBeGreaterThan(25);
    }
    // The MR (the other study) opens from the list.
    await panel.getByRole("button").filter({ hasText: /· MR/ }).click();
    await expect.poll(async () => /MR\s*·\s*Se/.test(await page.locator("body").innerText()), { timeout: 15_000 }).toBe(true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "web-two-studies.png") });
  });
});
