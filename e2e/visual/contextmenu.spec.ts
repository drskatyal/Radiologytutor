import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The viewer's right-click menu on the web (shared with the desktop:
// @flowrad/viewer-core contextMenu.ts): opens on right-click inside the
// viewer only (the browser's own menu everywhere else), long-press on touch,
// shortcuts shown, presets applied, DICOM tags viewer.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

async function openStudy(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer/local");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
}

test("right-click menu: sections, shortcuts, presets, DICOM tags; browser menu kept outside the viewer", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openStudy(page);
  const canvas = page.locator(".cs-viewport canvas, canvas").first();
  const box = (await canvas.boundingBox())!;

  // The browser's menu: suppressed on the image, untouched on the page.
  const prevented = await page.evaluate(() => {
    const fire = (el: Element | null) => {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el?.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return { image: fire(document.querySelector("canvas")), page: fire(document.querySelector("h1, header, footer") ?? document.body) };
  });
  expect(prevented.image, "no browser menu on the image").toBe(true);
  expect(prevented.page, "the browser menu stays elsewhere").toBe(false);

  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2, { button: "right" });
  const menu = page.getByRole("menu", { name: "Image" });
  await expect(menu).toBeVisible({ timeout: 3000 });
  const top = (await menu.locator(":scope > div > [role]").allInnerTexts()).map((t) => t.split("\n")[0]);
  for (const s of ["Tools", "Window / level", "Zoom, rotate, flip", "Reset view", "Export", "DICOM tags…"]) expect(top).toContain(s);
  await menu.getByRole("menuitem", { name: /^Window \/ level/ }).hover();
  const lung = page.getByRole("menuitemradio", { name: /^Lung/ });
  await expect(lung).toBeVisible();
  await expect(lung.locator("kbd")).toHaveText(/Shift\+\d/);
  await lung.click();
  await expect.poll(async () => /W 1500\s+L [-−]600/.test(await page.locator("body").innerText()), { timeout: 5000 }).toBe(true);

  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2, { button: "right" });
  await page.getByRole("menuitemradio", { name: /^DICOM tags/ }).click();
  const tags = page.getByTestId("dicom-tags");
  await expect(tags.locator("tbody tr").first()).toBeVisible({ timeout: 8000 });
  expect(await tags.locator("tbody tr").count()).toBeGreaterThan(15);
  await page.getByRole("searchbox", { name: "Search tags" }).fill("modality");
  await expect(tags.locator("tbody tr").first()).toContainText("CT");
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("long-press on the image opens the same menu", async ({ page }) => {
    test.setTimeout(90_000);
    await openStudy(page);
    const box = (await page.locator("canvas").first().boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.waitForTimeout(750);
    await expect(page.getByRole("menu", { name: "Image" })).toBeVisible({ timeout: 3000 });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });
});
