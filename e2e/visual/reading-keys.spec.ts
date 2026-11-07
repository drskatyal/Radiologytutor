import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

// RadiAnt's reading keys in the free viewer, as on the desktop:
// Ctrl/⌘+0 fit, Ctrl/⌘+1…4 zoom 100 / 200 / 400 / 800 % (one image pixel per
// screen pixel at 100 %), Ctrl/⌘+arrows pan, F12 show / hide annotations,
// and in the grid F5 / Shift+F5 / Alt+F5 links and Ctrl/⌘+F12 reference
// lines. F5 must never reload away an opened study. Synthetic CT only.

const CT = process.env.TEST_CT_DIR;
const MULTI = process.env.TEST_MULTI_DIR;

async function open(page: Page, dir: string) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(dir).map((f) => path.join(dir, f)));
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForSelector('[data-testid="annotation-state"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(800);
}

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();

/** Bright run along the middle row: the phantom's left edge and width, in screen px. */
async function bodySpan(page: Page): Promise<{ left: number; width: number }> {
  await page.waitForTimeout(250);
  const shot = await image(page).locator("canvas").first().screenshot();
  const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // The middle row (zoom keeps the centre still), clear of the side labels (R / L).
  const y = Math.floor(info.height / 2);
  const margin = Math.ceil(info.width * 0.04);
  let first = -1;
  let last = -1;
  for (let x = margin; x < info.width - margin; x += 1) {
    const i = (y * info.width + x) * info.channels;
    if (data[i]! + data[i + 1]! + data[i + 2]! > 90) {
      if (first < 0) first = x;
      last = x;
    }
  }
  return { left: first, width: first < 0 ? 0 : last - first + 1 };
}

test("reading keys: Ctrl+0…4 zoom levels, Ctrl+arrows pan, F12 annotations, F5 never reloads", async ({ page }) => {
  test.skip(!CT, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page, CT!);
  await image(page).focus();

  const fit = await bodySpan(page);
  expect(fit.width).toBeGreaterThan(100);

  // 100 % is one image pixel per screen pixel; 200 % twice that; Ctrl+0 fits again.
  await page.keyboard.press("Control+1");
  await expect(page.getByText("Zoom 100 %").first()).toBeVisible();
  const at100 = await bodySpan(page);
  await page.keyboard.press("Control+2");
  await expect(page.getByText("Zoom 200 %").first()).toBeVisible();
  const at200 = await bodySpan(page);
  expect(at200.width / at100.width).toBeGreaterThan(1.9);
  expect(at200.width / at100.width).toBeLessThan(2.1);
  await page.keyboard.press("Control+0");
  await expect(page.getByText("Fit to the pane").first()).toBeVisible();
  expect(Math.abs((await bodySpan(page)).width - fit.width)).toBeLessThanOrEqual(3);

  // The right-click "Actual size (1:1)" is the same 100 % (it used to only re-fit).
  await page.mouse.click(...(await (async () => {
    const b = (await image(page).boundingBox())!;
    return [b.x + b.width * 0.15, b.y + b.height * 0.15] as [number, number];
  })()), { button: "right" });
  const menu = page.getByRole("menu", { name: "Image" });
  await menu.getByRole("menuitem", { name: /^Zoom/ }).hover();
  const actual = page.getByRole("menuitemradio", { name: /^Actual size \(1:1\)/ });
  await expect(actual.locator("kbd")).toContainText("1");
  await actual.click();
  expect(Math.abs((await bodySpan(page)).width - at100.width)).toBeLessThanOrEqual(3);

  // Ctrl+arrows pan a fixed 40 px step at any zoom; bare arrows still change slice.
  await image(page).focus();
  const before = await bodySpan(page);
  await page.keyboard.press("Control+ArrowRight");
  const after = await bodySpan(page);
  // The view moves right, so the image moves 40 screen px left (as on the desktop).
  expect(after.left - before.left).toBeGreaterThanOrEqual(-43);
  expect(after.left - before.left).toBeLessThanOrEqual(-37);
  const slider = page.getByRole("slider", { name: "Slice" }).first();
  const at = Number(await slider.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowDown");
  await expect(slider).toHaveAttribute("aria-valuenow", String(at + 1));

  // F12: annotations hidden, then shown again.
  await page.keyboard.press("Control+0");
  const b = (await image(page).boundingBox())!;
  await page.keyboard.press("l");
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.5, { steps: 10 });
  await page.mouse.up();
  const svgText = () => image(page).locator("svg text").count();
  await expect.poll(svgText).toBeGreaterThan(0);
  await image(page).focus();
  await page.keyboard.press("F12");
  await expect(page.getByText("Annotations hidden").first()).toBeVisible();
  await expect.poll(svgText).toBe(0);
  await page.keyboard.press("F12");
  await expect.poll(svgText).toBeGreaterThan(0);

  // F5 on a single pane: no reload (the study stays open), and it says why nothing linked.
  await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
  await page.keyboard.press("F5");
  await expect(page.getByText("Linking needs two or more panes").first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  await expect(slider).toBeVisible();

  // PageDown / Shift+↑: 10 % of the images, as on the desktop.
  await image(page).focus();
  const total = Number(await slider.getAttribute("aria-valuemax")) - Number(await slider.getAttribute("aria-valuemin")) + 1;
  const page10 = Math.max(1, Math.round(total / 10));
  const from = Number(await slider.getAttribute("aria-valuenow"));
  await page.keyboard.press("PageDown");
  await expect(slider).toHaveAttribute("aria-valuenow", String(from + page10));
  await page.keyboard.press("Shift+ArrowUp");
  await expect(slider).toHaveAttribute("aria-valuenow", String(from));

  // Shift+Backspace: rotation and flips back, zoom kept (the overlay's zoom is unchanged).
  await image(page).focus();
  await page.keyboard.press("Control+2");
  const zoomText = () => image(page).locator("xpath=..").innerText().then((t) => /Zoom \d+%/.exec(t)?.[0] ?? "");
  await expect.poll(zoomText).not.toBe("");
  const zoomed = await zoomText();
  await page.keyboard.press("r");
  await page.keyboard.press("Shift+Backspace");
  await expect(page.getByText("Reset orientation").first()).toBeVisible();
  expect(await zoomText()).toBe(zoomed);

  // The help sheet lists them.
  await page.keyboard.press("Shift+?");
  const help = page.getByRole("dialog");
  await expect(help.getByText("Fit to the pane")).toBeVisible();
  await expect(help.getByText(/Zoom 100 \/ 200 \/ 400 \/ 800 %/)).toBeVisible();
  await expect(help.getByText("Show / hide annotations")).toBeVisible();
  expect(errors).toEqual([]);
});

test("reading keys in the grid: F5 / Shift+F5 / Alt+F5 links and Ctrl+F12 reference lines follow the layout bar", async ({ page }) => {
  test.skip(!MULTI, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page, MULTI!);
  await page.getByRole("radio", { name: "Side by side layout" }).click();
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
  await page.waitForTimeout(800);
  await page.getByTestId("viewer-pane").first().click({ position: { x: 80, y: 80 } });

  const bar = (name: string) => page.getByRole("button", { name });
  const flip = async (key: string, name: string) => {
    const was = await bar(name).getAttribute("aria-pressed");
    await page.keyboard.press(key);
    await expect(bar(name)).toHaveAttribute("aria-pressed", was === "true" ? "false" : "true");
  };
  await flip("F5", "Link scroll");
  await flip("F5", "Link scroll");
  await flip("Shift+F5", "Link window / level");
  await flip("Alt+F5", "Link zoom and pan");
  await flip("Control+F12", "Reference lines");
  expect(errors).toEqual([]);
});
