import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Help › Customise (Mouse & keyboard) is a dark dialog; the shared bindings
// panel inside it (also the desktop's Mouse & Keyboard) draws with the theme
// tokens. It now takes the reading room's dark tokens, so its labels,
// commands and controls read on the dark panel in a light system theme too
// (they were dark on dark). Checked as WCAG contrast against the dialog.

const DIR = process.env.TEST_CT_DIR;
const SHOTS = process.env.SCREENSHOT_DIR;

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();

async function openCustomise(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).sort().map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
  await image(page).click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Shift+?");
  await page.getByRole("dialog", { name: /Viewer shortcuts/ }).getByRole("button", { name: "Customise" }).click();
  const panel = page.locator("[data-bindings-panel=web]");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

/** WCAG contrast of an element's text (and, for controls, its own background) on the dialog. */
function contrastOf(page: Page, selector: string, against: "dialog" | "self") {
  return page.evaluate(
    ({ selector, against }) => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return 0;
      const dialog = el.closest('[role="dialog"]') as HTMLElement;
      const bg = parse(getComputedStyle(against === "self" ? el : dialog).backgroundColor);
      const fg = parse(getComputedStyle(el).color);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    },
    { selector, against }
  );
}

test("bindings panel: labels, commands and controls read on the dark Customise dialog", async ({ page }) => {
  test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: "light" });
  await openCustomise(page);

  // Mouse tab: an input's name, a fixed command, and a command picker.
  expect(await contrastOf(page, "[data-bindings-panel=web] [data-binding-input] > span", "dialog")).toBeGreaterThanOrEqual(4.5);
  expect(await contrastOf(page, "[data-bindings-panel=web] [data-binding-input] > span + span", "dialog")).toBeGreaterThanOrEqual(4.5);
  expect(await contrastOf(page, "[data-bindings-panel=web] [data-binding-input] select", "self")).toBeGreaterThanOrEqual(4.5);
  // The picker itself is dark, not a light box on the dark panel.
  const selectBg = await page.evaluate(() => {
    const el = document.querySelector("[data-bindings-panel=web] [data-binding-input] select") as HTMLElement;
    const [r, g, b] = (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
    return (r + g + b) / 3;
  });
  expect(selectBg).toBeLessThan(80);

  // Keyboard tab: a command's name.
  await page.locator("[data-bindings-panel=web]").getByRole("tab", { name: /Keyboard/ }).click();
  await expect(page.locator("[data-binding-row]").first()).toBeVisible();
  expect(await contrastOf(page, "[data-binding-row]", "dialog")).toBeGreaterThanOrEqual(4.5);
});

// The screenshot for people (SCREENSHOT_DIR): sharp at 2×.
test.describe("screenshot", () => {
  test.use({ deviceScaleFactor: 2 });
  test("bindings panel: screenshot", async ({ page }) => {
    test.skip(!DIR || !SHOTS, "SCREENSHOT_DIR and TEST_CT_DIR are not set");
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: "light" });
    const panel = await openCustomise(page);
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS!, "bindings-on-dark.png") });
  });
});
