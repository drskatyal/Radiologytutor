import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Web multi-window: "Pop out to new window" opens the series in a second
// browser window (the files are handed over, nothing uploaded); scrolling
// stays linked between the windows (W/L is linked the same way), and the link
// can be switched off. The desktop's monitor picker is covered by
// desktop/scripts/e2e-ui.mjs.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

const slice = async (page: Page) => Number(await page.getByRole("slider", { name: "Slice" }).first().getAttribute("aria-valuenow"));

test("pop out: the series opens in a new window, scroll stays linked, and the link can be switched off", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer/local");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);

  const popupWait = context.waitForEvent("page");
  await page.getByRole("button", { name: "Pop out to new window" }).click();
  const popup = await popupWait;
  await popup.setViewportSize({ width: 1200, height: 900 });
  const popErrors: string[] = [];
  popup.on("pageerror", (e) => popErrors.push(String(e)));
  await expect(popup.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Windows linked/ })).toBeVisible({ timeout: 10_000 });

  // Scroll the main window: the pop-out follows.
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  for (let i = 0; i < 12; i += 1) await page.keyboard.press("ArrowDown");
  await expect.poll(async () => Math.abs((await slice(popup)) - (await slice(page))), { timeout: 8000 }).toBeLessThanOrEqual(1);
  expect(await slice(page)).toBeGreaterThan(1);

  // Unlink: scrolling the main window no longer moves the pop-out.
  await page.getByRole("button", { name: /Windows linked/ }).click();
  await expect(page.getByRole("button", { name: /Windows unlinked/ })).toBeVisible();
  const held = await slice(popup);
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(800);
  expect(await slice(popup)).toBe(held);

  await popup.close();
  expect(popErrors).toEqual([]);
});
