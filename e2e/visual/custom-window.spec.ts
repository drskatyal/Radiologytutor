import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Set window (exact width / level), as on the desktop (Ctrl+F11): from the
// Window menu, the keyboard and the right-click menu. Values are validated,
// Esc cancels, and the overlay shows the typed window. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

async function openStudy(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
}

/** The overlay's window line, "W 400 L 40" (a minus may be typographic). */
const showsWindow = (page: Page, ww: number, wc: number) =>
  expect
    .poll(async () => new RegExp(`W ${ww}\\s+L [-−]?${Math.abs(wc)}\\b`).test(await page.locator("body").innerText()), { timeout: 5000 })
    .toBe(true);

test("Set window: Window menu, Ctrl+F11 and right-click; validated; Esc cancels", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openStudy(page);
  const dialog = page.getByRole("dialog", { name: "Set window" });
  const width = dialog.getByLabel(/^Width \(WW\)/);
  const level = dialog.getByLabel(/^Level \(WL\)/);

  // Window menu → Set window…, starts from the window on screen, as the
  // overlay shows it (CT: HU).
  await page.getByRole("button", { name: /^Window presets/ }).click();
  await page.getByRole("menuitemradio", { name: /^Set window/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Width (WW), HU")).toBeVisible();
  // The reading room's dark surface, not the app's paper theme.
  const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = (bg.match(/\d+/g) ?? []).map(Number);
  expect(r! + g! + b!, `dialog background ${bg}`).toBeLessThan(150);
  await showsWindow(page, 399, 40);
  await expect(width).toHaveValue("399");
  await expect(level).toHaveValue("40");
  await width.fill("1500");
  await level.fill("-600");
  await level.press("Enter");
  await expect(dialog).toBeHidden();
  await showsWindow(page, 1500, -600);

  // Ctrl+F11 from the image: starts from that window; a width under 1 can't be applied.
  const image = page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
  await image.focus();
  await page.keyboard.press("Control+F11");
  await expect(dialog).toBeVisible();
  await expect(width).toHaveValue("1500");
  await expect(level).toHaveValue("-600");
  await width.fill("0");
  await expect(dialog.getByText("At least 1")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  // Esc cancels: the window is unchanged.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await showsWindow(page, 1500, -600);

  // Right-click → Window / level → Set window…
  const box = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2, { button: "right" });
  const menu = page.getByRole("menu", { name: "Image" });
  await menu.getByRole("menuitem", { name: /^Window \/ level/ }).hover();
  const item = page.getByRole("menuitemradio", { name: /^Set window/ });
  await expect(item.locator("kbd")).toContainText("F11");
  await item.click();
  await expect(dialog).toBeVisible();
  await width.fill("80");
  await level.fill("35");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await showsWindow(page, 80, 35);
  expect(errors).toEqual([]);
});
