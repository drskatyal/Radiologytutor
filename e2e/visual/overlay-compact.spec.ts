import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The compact overlay, as the desktop draws it: a pane under 520 × 380 (a
// grid cell) shows one line per corner, so the text doesn't cover a small
// pane's anatomy; a large pane keeps the full corner text. Synthetic study.

const MULTI = process.env.TEST_MULTI_DIR;

test("overlay: full in a large pane, one line per corner in small grid panes", async ({ page }) => {
  test.skip(!MULTI, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(MULTI!).map((f) => path.join(MULTI!, f)));
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);

  const flags = () => page.locator("[data-overlay-compact]").evaluateAll((els) => els.map((e) => e.getAttribute("data-overlay-compact")));
  const seriesLines = () => page.locator("p", { hasText: /Se \d+/ }).count();

  // One large pane: the full overlay (the series line "CT · Se n" is there).
  await expect.poll(flags).toEqual(["false"]);
  await expect.poll(seriesLines).toBeGreaterThan(0);

  // A 2 × 2 grid on a smaller window: every pane is compact, the secondary lines go.
  await page.setViewportSize({ width: 1000, height: 700 });
  // The layout bar is a wide-screen control: use the desktop's key (Shift+4 = 2 × 2).
  await page.locator('[role="img"][aria-label^="DICOM viewer"]').first().focus();
  await page.keyboard.press("Shift+Digit4");
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(4, { timeout: 30_000 });
  await expect.poll(async () => (await flags()).every((f) => f === "true") && (await flags()).length >= 4).toBe(true);
  await expect.poll(seriesLines).toBe(0);

  // Back to one pane on a large window: full again (it follows resizes).
  await page.locator('[role="img"][aria-label^="DICOM viewer"]').first().focus();
  await page.keyboard.press("Shift+Digit1");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(flags).toEqual(["false"]);
  await expect.poll(seriesLines).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
