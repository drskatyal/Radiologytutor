import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The desktop's navigation keys in the free viewer: Space plays cine,
// Shift+[ / ] slow / speed it, [ / ] change series, Ctrl/⌘+M MPR,
// Ctrl/⌘+Shift+M 3D (each again for the stack), Ctrl/⌘+Shift+F12 overlay
// text on / off, and F full screen. Synthetic CT only.

const MULTI = process.env.TEST_MULTI_DIR;
test.skip(!MULTI, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
const layout = (page: Page) => page.locator('[data-mpr-layout]');

test("nav keys: Space cine, [ / ] series, Ctrl+M MPR, Ctrl+Shift+M 3D, Ctrl+Shift+F12 overlay, F full screen", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(MULTI!).map((f) => path.join(MULTI!, f)));
  const slider = page.getByRole("slider", { name: "Slice" }).first();
  await expect(slider).toBeVisible({ timeout: 30_000 });
  await page.waitForSelector('[data-testid="annotation-state"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(800);
  await image(page).focus();

  // Space: cine plays (the toolbar's button follows), Shift+] speeds it, Space pauses.
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause cine" }).first()).toBeVisible();
  await page.keyboard.press("Shift+BracketRight");
  await expect(page.getByText(/^Cine \d+ fps$/).first()).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play cine" }).first()).toBeVisible();

  // ] and [: next and previous series (the overlay names it).
  // The overlay sits beside the image, inside the viewport's own box.
  const seriesLine = () => image(page).locator("xpath=..").innerText().then((t) => /Se \d+/.exec(t)?.[0] ?? "");
  const first = await seriesLine();
  expect(first).not.toBe("");
  await page.keyboard.press("]");
  await expect.poll(seriesLine, { timeout: 30_000 }).not.toBe(first);
  await image(page).focus();
  await page.keyboard.press("[");
  await expect.poll(seriesLine, { timeout: 30_000 }).toBe(first);

  // Ctrl+M: three-plane MPR; again for the stack.
  await image(page).focus();
  await page.keyboard.press("Control+m");
  await expect(layout(page)).toHaveAttribute("data-mpr-render", "mpr", { timeout: 30_000 });
  await expect(layout(page)).not.toHaveAttribute("data-mpr-maximized", /./);
  await page.keyboard.press("Control+m");
  await expect(layout(page)).toHaveCount(0, { timeout: 10_000 });

  // Ctrl+Shift+M: 3D; again for the stack.
  await image(page).focus();
  await page.keyboard.press("Control+Shift+M");
  await expect(layout(page)).toHaveAttribute("data-mpr-render", "3d", { timeout: 30_000 });
  await page.keyboard.press("Control+Shift+M");
  await expect(layout(page)).toHaveCount(0, { timeout: 10_000 });

  // Ctrl+Shift+F12: overlay text off, then on.
  await image(page).focus();
  await expect.poll(seriesLine).not.toBe("");
  await page.keyboard.press("Control+Shift+F12");
  await expect(page.getByText("Overlay off").first()).toBeVisible();
  await expect.poll(seriesLine).toBe("");
  await page.keyboard.press("Control+Shift+F12");
  await expect.poll(seriesLine).not.toBe("");

  // F: full screen (the stage's button follows), F again leaves.
  await image(page).focus();
  await page.keyboard.press("f");
  await expect(page.getByRole("button", { name: "Exit fullscreen" })).toBeVisible();
  await image(page).focus();
  await page.keyboard.press("f");
  // (The stage's button lives in the phone bar; wide screens only have F.)
  await expect(page.getByRole("button", { name: "Exit fullscreen" })).toHaveCount(0);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

  // The help sheet lists them.
  await image(page).focus();
  await page.keyboard.press("Shift+?");
  const help = page.getByRole("dialog");
  await expect(help.getByText("Previous / next series")).toBeVisible();
  await expect(help.getByText(/^MPR: three planes/)).toBeVisible();
  expect(errors).toEqual([]);
});
