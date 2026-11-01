import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Annotation editing on the web viewer (/viewer/local), real mouse and keys:
// arrow without a prompt, inline label, select + Delete, undo / redo, the
// right-click menu (Delete all on this image), and the eraser. The same layer
// (components/viewer/AnnotationEditLayer) runs in the desktop viewer, where
// desktop/scripts/e2e-ui.mjs covers it.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

async function openStudy(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/viewer/local");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await page.waitForSelector('[data-testid="annotation-state"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(1200);
}

const state = (page: Page) =>
  page.getByTestId("annotation-state").evaluate((el: HTMLElement) => ({
    onImage: Number(el.dataset.onImage),
    selected: Number(el.dataset.selected),
    labels: Number(el.dataset.labels),
  }));

async function pickMeasureTool(page: Page, label: RegExp) {
  await page.getByRole("button", { name: "More measurement tools" }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
}

test("annotations: optional arrow label, select/delete, undo/redo, menu, eraser", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs += 1;
    await d.dismiss();
  });
  // Tall enough that the docked viewer is fully on screen (no scrolling mid-test).
  await page.setViewportSize({ width: 1440, height: 1400 });
  await openStudy(page);
  const image = page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
  await image.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(300);
  const b = (await image.boundingBox())!;
  const P = (fx: number, fy: number): [number, number] => [b.x + b.width * fx, b.y + b.height * fy];

  // Arrow with no prompt.
  await pickMeasureTool(page, /^Arrow/);
  const a1 = P(0.35, 0.35);
  const a2 = P(0.5, 0.5);
  await page.mouse.move(...a1);
  await page.mouse.down();
  await page.mouse.move(...a2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => state(page)).toMatchObject({ onImage: 1, labels: 0 });
  expect(dialogs, "no browser prompt").toBe(0);

  // Inline label.
  const mid: [number, number] = [(a1[0] + a2[0]) / 2, (a1[1] + a2[1]) / 2];
  await page.mouse.dblclick(...mid);
  const input = page.getByTestId("annotation-label-input");
  await expect(input).toBeVisible();
  await input.fill("Nodule");
  await input.press("Enter");
  await expect.poll(() => state(page)).toMatchObject({ labels: 1 });

  // Select (click) + Delete, then undo / redo.
  await page.mouse.click(...mid);
  await expect.poll(() => state(page)).toMatchObject({ selected: 1 });
  await page.keyboard.press("Delete");
  await expect.poll(() => state(page)).toMatchObject({ onImage: 0 });
  await page.keyboard.press("Control+z");
  await expect.poll(() => state(page)).toMatchObject({ onImage: 1 });
  await page.keyboard.press("Control+y");
  await expect.poll(() => state(page)).toMatchObject({ onImage: 0 });
  await page.keyboard.press("Control+z");
  await expect.poll(() => state(page)).toMatchObject({ onImage: 1 });

  // Right-click menu: delete everything on this image, then undo.
  await page.mouse.click(...P(0.15, 0.8), { button: "right" });
  const menu = page.getByRole("menu", { name: "Annotation" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: /^Delete all on this image/ }).click();
  await expect.poll(() => state(page)).toMatchObject({ onImage: 0 });
  await page.keyboard.press("Control+z");
  await expect.poll(() => state(page)).toMatchObject({ onImage: 1 });

  // Eraser.
  await pickMeasureTool(page, /^Eraser/);
  await page.mouse.click(...mid);
  await expect.poll(() => state(page)).toMatchObject({ onImage: 0 });
  expect(dialogs).toBe(0);
});
