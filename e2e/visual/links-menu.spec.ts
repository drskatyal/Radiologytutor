import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer grid, desktop parity: the right-click Link submenu (scroll by
// position, window / level, zoom and pan), Reference lines, and "Link at what
// each pane shows now" (Ctrl/⌘+Shift+L, registers a prior) — the same state
// as the layout bar's link toggles. A single viewer offers none of them.
// Synthetic multi-series CT only.

const DIR = process.env.TEST_MULTI_DIR;
test.skip(!DIR, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");

async function open(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
}

const pane = (page: Page, i: number) => page.getByTestId("viewer-pane").nth(i);
const text = (page: Page, i: number) => pane(page, i).innerText();
const imageMenu = (page: Page) => page.getByRole("menu", { name: "Image" });

async function rightClick(page: Page, at: { x: number; y: number }) {
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(imageMenu(page)).toBeVisible();
}

test("links: right-click Link submenu, reference lines and link-at-current follow the layout bar", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page);

  // One viewer: no Link submenu.
  const canvas = (await page.locator("canvas").first().boundingBox())!;
  await rightClick(page, { x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.3 });
  await expect(imageMenu(page).getByRole("menuitem", { name: /^Link/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Side by side: the submenu mirrors the bar (scroll on, W/L and zoom off).
  await page.getByRole("radio", { name: "Side by side layout" }).click();
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const box = (await pane(page, 0).boundingBox())!;
  const inPane = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
  await rightClick(page, inPane);
  await imageMenu(page).getByRole("menuitem", { name: /^Link/ }).hover();
  await expect(page.getByRole("menuitemradio", { name: /^Scroll \(position\)/ })).toHaveAttribute("aria-checked", "true");
  const wlItem = page.getByRole("menuitemradio", { name: /^Window \/ level/ });
  await expect(wlItem).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("menuitemradio", { name: /^Link at what each pane shows now/ }).locator("kbd")).toContainText("L");

  // Turn W/L linking on from the menu: the bar's toggle follows, and a preset in one pane reaches the other.
  await wlItem.press("Enter");
  await expect(page.getByRole("button", { name: "Link window / level" })).toHaveAttribute("aria-pressed", "true");
  await pane(page, 0).click({ position: { x: 80, y: 80 } });
  await page.keyboard.press("2");
  await expect.poll(() => text(page, 1)).toMatch(/W 2500 L 480/);

  // Reference lines: off from the menu, the bar follows; checked state shows it.
  await rightClick(page, inPane);
  await expect(imageMenu(page).getByRole("menuitemradio", { name: /^Reference lines/ })).toHaveAttribute("aria-checked", "true");
  await imageMenu(page).getByRole("menuitemradio", { name: /^Reference lines/ }).press("Enter");
  await expect(page.getByRole("button", { name: "Reference lines" })).toHaveAttribute("aria-pressed", "false");

  // Link at current: scroll linking off, then Ctrl+Shift+L turns it back on (and says so).
  await page.getByRole("button", { name: "Link scroll" }).click();
  await expect(page.getByRole("button", { name: "Link scroll" })).toHaveAttribute("aria-pressed", "false");
  await pane(page, 0).click({ position: { x: 80, y: 80 } });
  await page.keyboard.press("Control+Shift+L");
  await expect(page.getByText("Linked at what each pane shows now").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Link scroll" })).toHaveAttribute("aria-pressed", "true");

  // Linked scrolling works from there: a scroll in pane 1 moves pane 2.
  const slider2 = page.getByRole("slider", { name: "Slice" }).nth(1);
  const before = await slider2.getAttribute("aria-valuenow");
  await pane(page, 0).click({ position: { x: 80, y: 80 } });
  for (let k = 0; k < 4; k += 1) await page.keyboard.press("ArrowDown");
  await expect.poll(() => slider2.getAttribute("aria-valuenow")).not.toBe(before);

  expect(errors).toEqual([]);
});
