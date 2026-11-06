import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer (/viewer): hanging layouts like the desktop viewer. Side by
// side, stacked and 2×2, each pane on its own series (a series from the panel
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
