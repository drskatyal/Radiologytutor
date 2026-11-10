import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer (/viewer): panes of a hanging layout scroll together by patient
// position (on by default), and "Unlinked" lets each pane scroll on its own.
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
}

const sliders = (page: Page) => page.getByRole("slider", { name: "Slice" });
const at = async (page: Page, i: number) => Number(await sliders(page).nth(i).getAttribute("aria-valuenow"));
/** Both panes' positions, read together. */
const both = async (page: Page) => [await at(page, 0), await at(page, 1)] as const;

test("side by side: scrolling one pane takes the other to the same position; Unlinked lets it go", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole("radio", { name: "Side by side layout" }).click();
  await expect(sliders(page)).toHaveCount(2, { timeout: 30_000 });
  const toggle = page.getByRole("button", { name: "Link scroll" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(800);

  // Scroll pane 1: pane 2 follows.
  const pane1 = page.getByTestId("viewer-pane").nth(0);
  await pane1.click({ position: { x: 80, y: 80 } });
  const start = await at(page, 1);
  for (let k = 0; k < 6; k += 1) await page.keyboard.press("ArrowDown");
  await expect.poll(async () => { const [a, b] = await both(page); return a !== start && a === b; }).toBe(true);

  // Scroll pane 2: pane 1 follows back.
  await page.getByTestId("viewer-pane").nth(1).click({ position: { x: 80, y: 80 } });
  const before = await at(page, 1);
  for (let k = 0; k < 3; k += 1) await page.keyboard.press("ArrowUp");
  await expect.poll(async () => { const [a, b] = await both(page); return b !== before && a === b; }).toBe(true);

  // Unlinked: pane 2 stays where it is.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const held = await at(page, 1);
  await pane1.click({ position: { x: 80, y: 80 } });
  for (let k = 0; k < 4; k += 1) await page.keyboard.press("ArrowDown");
  await expect.poll(() => at(page, 0)).not.toBe(held);
  await page.waitForTimeout(500);
  expect(await at(page, 1)).toBe(held);
});
