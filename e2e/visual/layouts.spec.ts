import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer (/viewer): hanging layouts like the desktop viewer. Side by
// side, stacked, 2×2, three across, 2×3 and 3×3 (the bigger grids offered when
// there are series to fill them), and maximise a pane (double-click / Enter,
// Esc restores). Each pane on its own series (a series from the panel
// goes to the focused pane, or is dragged onto any pane), one toolbar that
// follows focus, G to cycle. Synthetic multi-series CT only.

const DIR = process.env.TEST_MULTI_DIR;
test.skip(!DIR, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");

async function open(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const panes = (page: Page) => page.getByTestId("viewer-pane");
const series = (page: Page) => page.getByRole("complementary", { name: "Series" }).getByRole("list", { name: "Series" }).getByRole("button");

test("2×2: four panes, each with its own image, one toolbar that follows focus", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await expect(panes(page)).toHaveCount(0);
  await page.getByRole("radio", { name: "2 × 2 layout" }).click();
  await expect(panes(page)).toHaveCount(4);
  // Every pane draws its own image.
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(4, { timeout: 30_000 });
  // One toolbar for the grid.
  await expect(page.getByRole("button", { name: "Reset view" })).toHaveCount(1);
  // Focus moves with a click; the outline follows.
  await panes(page).nth(3).click({ position: { x: 60, y: 60 } });
  await expect(panes(page).nth(3)).toHaveAttribute("data-active", "true");
  await expect(panes(page).nth(0)).not.toHaveAttribute("data-active", "true");
  // Each series that is hung carries its pane number in the panel.
  await expect(page.getByLabel(/^In pane /)).not.toHaveCount(0);
});

test("a series from the panel goes to the focused pane; dragging hangs it on any pane", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole("radio", { name: "Side by side layout" }).click();
  await expect(panes(page)).toHaveCount(2);
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
  const count = await series(page).count();
  expect(count).toBeGreaterThan(1);

  // Focus pane 2, click the first series: pane 2 shows it, pane 1 is unchanged.
  await panes(page).nth(1).click({ position: { x: 60, y: 60 } });
  await series(page).first().click();
  await expect(series(page).first()).toHaveAttribute("aria-pressed", "true");
  await expect(series(page).first().getByLabel(/In pane .*2/)).toBeVisible();

  // Drag the last series onto pane 1.
  await series(page).last().dragTo(panes(page).nth(0));
  await expect(series(page).last().getByLabel(/In pane 1/)).toBeVisible();
  await expect(panes(page).nth(0)).toHaveAttribute("data-active", "true");
});

test("G cycles the layouts; one up returns to a single viewer", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.locator("canvas").first().click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("g");
  await expect(panes(page)).toHaveCount(2);
  await page.keyboard.press("g");
  await expect(panes(page)).toHaveCount(2); // stacked
  await page.keyboard.press("g");
  await expect(panes(page)).toHaveCount(4);
  await page.getByRole("radio", { name: "Single layout" }).click();
  await expect(panes(page)).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(1);
});

test("the desktop's larger grids: 2 × 3 hangs six series, each pane on its own", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  // Six series: three across and 2 × 3 are offered, 3 × 3 is not (nothing to fill it).
  await expect(page.getByRole("radio", { name: "Three across layout" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "3 × 3 layout" })).toHaveCount(0);
  await page.getByRole("radio", { name: "2 × 3 layout" }).click();
  await expect(panes(page)).toHaveCount(6);
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(6, { timeout: 30_000 });
  // Every series is hung once.
  for (let pane = 1; pane <= 6; pane += 1) await expect(page.getByLabel(new RegExp(`^In pane ${pane}$`))).toHaveCount(1);
  // Three columns, two rows.
  const boxes = await Promise.all([0, 1, 2, 3].map((i) => panes(page).nth(i).boundingBox()));
  expect(Math.abs(boxes[0]!.y - boxes[2]!.y)).toBeLessThan(2);
  expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 2);
  // G from here wraps back to one up.
  await panes(page).nth(0).click({ position: { x: 60, y: 60 } });
  await page.keyboard.press("g");
  await expect(panes(page)).toHaveCount(0);
});

test("maximise a pane: double-click, Enter or its button; Esc restores the grid", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole("radio", { name: "2 × 2 layout" }).click();
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(4, { timeout: 30_000 });
  const grid = page.getByTestId("viewer-grid");
  const gridBox = (await grid.boundingBox())!;

  // Double-click pane 3: it fills the grid; the others stay mounted, hidden.
  await panes(page).nth(2).dblclick({ position: { x: 80, y: 80 } });
  await expect(panes(page).nth(2)).toHaveAttribute("data-maximized", "true");
  await expect(panes(page).nth(2)).toHaveAttribute("data-active", "true");
  await expect(panes(page)).toHaveCount(4);
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(1);
  const big = (await panes(page).nth(2).boundingBox())!;
  expect(big.width).toBeGreaterThan(gridBox.width - 4);
  expect(big.height).toBeGreaterThan(gridBox.height - 4);
  // Its image is redrawn at the new size (not a 0×0 or quarter-size canvas).
  await expect
    .poll(async () => (await panes(page).nth(2).locator("canvas").first().boundingBox())?.width ?? 0)
    .toBeGreaterThan(gridBox.width - 8);

  // Esc restores; the hidden panes come back with their images.
  await page.keyboard.press("Escape");
  await expect(panes(page).nth(2)).not.toHaveAttribute("data-maximized", "true");
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(4);
  await expect
    .poll(async () => (await panes(page).nth(0).locator("canvas").first().boundingBox())?.width ?? 0)
    .toBeGreaterThan(gridBox.width / 2 - 8);

  // Enter on the outlined pane maximises it, Enter again restores.
  await panes(page).nth(1).click({ position: { x: 60, y: 60 } });
  await page.keyboard.press("Enter");
  await expect(panes(page).nth(1)).toHaveAttribute("data-maximized", "true");
  await page.keyboard.press("Enter");
  await expect(panes(page).nth(1)).not.toHaveAttribute("data-maximized", "true");

  // The button on a pane does the same.
  await page.getByRole("button", { name: "Maximise pane 4" }).click();
  await expect(panes(page).nth(3)).toHaveAttribute("data-maximized", "true");
  await page.getByRole("button", { name: "Restore the grid (pane 4)" }).click();
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(4);

  // Another layout shows the whole grid.
  await panes(page).nth(0).dblclick({ position: { x: 80, y: 80 } });
  await expect(panes(page).nth(0)).toHaveAttribute("data-maximized", "true");
  await page.getByRole("radio", { name: "Side by side layout" }).click();
  await expect(panes(page)).toHaveCount(2);
  await expect(page.locator("[data-maximized=true]")).toHaveCount(0);
});
