import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The Measurements panel (free viewer): every measurement in the study as a
// list (kind, value, series and image), click one to go to its image, delete
// one (Ctrl+Z brings it back), and copy them all as numbered report lines.
// The desktop viewer has no such list. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
const slider = (page: Page) => page.getByRole("slider", { name: "Slice" }).first();
const panel = (page: Page) => page.getByRole("dialog", { name: "Measurements" });
const openPanel = (page: Page) => page.getByRole("button", { name: "Measurements (list, copy as report text)" }).click();

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 10 });
  await page.mouse.up();
}

test("measurements: list, jump to image, delete and undo, copy as report text", async ({ page, context }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(fs.readdirSync(DIR!).map((f) => path.join(DIR!, f)));
  await expect(slider(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForSelector('[data-testid="annotation-state"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(800);

  // Empty first.
  await openPanel(page);
  await expect(panel(page)).toContainText("No measurements yet");
  await expect(panel(page).getByRole("button", { name: "Copy as report text" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // A length on the opening slice, then an ellipse ROI five slices on.
  const at = await slider(page).getAttribute("aria-valuenow");
  const b = (await image(page).boundingBox())!;
  const P = (fx: number, fy: number): [number, number] => [b.x + b.width * fx, b.y + b.height * fy];
  await image(page).focus();
  await page.keyboard.press("l");
  await drag(page, P(0.3, 0.5), P(0.6, 0.5));
  await page.keyboard.press("e");
  for (let k = 0; k < 5; k += 1) await page.keyboard.press("ArrowDown");
  await expect(slider(page)).toHaveAttribute("aria-valuenow", String(Number(at) + 5));
  await drag(page, P(0.42, 0.42), P(0.52, 0.52));
  await page.waitForTimeout(500);

  // The list: both, in image order, each with its own reading and place.
  await openPanel(page);
  const values = panel(page).getByTestId("measurement-value");
  await expect(values).toHaveCount(2);
  await expect(panel(page)).toContainText(`CT Se 2 · Im ${at}`);
  await expect(values.nth(0)).toHaveText(/^\d+\.\d mm$/);
  await expect(values.nth(1)).toHaveText(/^Mean -?\d+\.\d HU · SD \d+\.\d · Area \d+\.\d+ (cm²|mm²)$/);

  // Copy as report text: numbered lines, no patient details.
  await panel(page).getByRole("button", { name: "Copy as report text" }).click();
  await expect(panel(page).getByRole("button", { name: "Copied" })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(new RegExp(`^1\\. Length \\d+\\.\\d mm — CT Se 2, Im ${at}$`));
  expect(lines[1]).toMatch(/^2\. Ellipse ROI Mean .* — CT Se 2, Im \d+$/);
  expect(text).not.toMatch(/TEST\^CT|CI-0001/);

  // A row takes the viewer to its image.
  await panel(page).getByRole("button", { name: /^1 Length/ }).click();
  await expect(panel(page)).toBeHidden();
  await expect(slider(page)).toHaveAttribute("aria-valuenow", at!);

  // Delete one from the list; Ctrl+Z brings it back.
  await openPanel(page);
  await panel(page).getByRole("button", { name: "Delete Length 1" }).click();
  await expect(panel(page).getByTestId("measurement-value")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await image(page).focus();
  await page.keyboard.press("Control+z");
  await openPanel(page);
  await expect(panel(page).getByTestId("measurement-value")).toHaveCount(2);

  // Also on the right-click menu.
  await page.keyboard.press("Escape");
  await page.mouse.click(...P(0.15, 0.15), { button: "right" });
  await page.getByRole("menu", { name: "Image" }).getByRole("menuitemradio", { name: /^Measurements…/ }).click();
  await expect(panel(page)).toBeVisible();

  expect(errors).toEqual([]);
});
