import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer (/viewer): reference lines between panes. With an axial and a
// coronal series of one frame of reference side by side, each pane draws
// where the other's image cuts it; scrolling the axial moves its line on the
// coronal; "Lines" hides them. Synthetic CT (scripts/make-test-ortho.py).

const DIR = process.env.TEST_ORTHO_DIR;
test.skip(!DIR, "TEST_ORTHO_DIR is not set (scripts/make-test-ortho.py)");

async function sideBySide(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: "Side by side layout" }).click();
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
}

const pane = (page: Page, i: number) => page.getByTestId("viewer-pane").nth(i);
const lineIn = (page: Page, i: number) => pane(page, i).getByTestId("remote-reference-lines").locator("line");
const y1 = async (page: Page, i: number) => Number(await lineIn(page, i).first().getAttribute("y1"));

test("axial beside coronal: each draws the other's plane; the line follows a scroll; Lines hides them", async ({ page }) => {
  test.setTimeout(120_000);
  await sideBySide(page);
  // Both panes cross: one line in each.
  await expect(lineIn(page, 0)).toHaveCount(1, { timeout: 15_000 });
  await expect(lineIn(page, 1)).toHaveCount(1);

  // Find the coronal pane (its line is the axial plane: horizontal) and scroll the axial one.
  const horizontal = async (i: number) => {
    const l = lineIn(page, i).first();
    return Math.abs(Number(await l.getAttribute("y1")) - Number(await l.getAttribute("y2"))) < 1;
  };
  const coronal = (await horizontal(0)) ? 0 : 1;
  const axial = 1 - coronal;
  expect(await horizontal(coronal)).toBe(true);
  const before = await y1(page, coronal);
  await pane(page, axial).click({ position: { x: 80, y: 80 } });
  for (let k = 0; k < 8; k += 1) await page.keyboard.press("ArrowDown");
  await expect.poll(() => y1(page, coronal)).not.toBe(before);

  // Lines off: none drawn.
  const toggle = page.getByRole("button", { name: "Reference lines" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(page.getByTestId("remote-reference-lines")).toHaveCount(0);
});

test("parallel planes draw no lines", async ({ page }) => {
  test.setTimeout(120_000);
  await sideBySide(page);
  // Put the same (axial) series in both panes: parallel, so no line anywhere.
  const series = page.getByRole("complementary", { name: "Series" }).getByRole("list", { name: "Series" }).getByRole("button");
  await pane(page, 1).click({ position: { x: 80, y: 80 } });
  await series.filter({ hasText: "Axial" }).first().click();
  await pane(page, 0).click({ position: { x: 80, y: 80 } });
  await series.filter({ hasText: "Axial" }).first().click();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("remote-reference-lines")).toHaveCount(0);
});
