import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The free viewer's full measure set, as on the desktop: Cobb angle,
// bidirectional (D), circle and freehand ROIs, and the magnifying glass. Each
// is drawn with the real mouse on the synthetic CT and must land as an
// editable annotation (AnnotationEditLayer counts them) with its reading.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

async function openStudy(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto("/viewer/local");
  const consent = page.getByRole("button", { name: "Continue" });
  if (await consent.count()) await consent.first().click();
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
  await page.waitForSelector('[data-testid="annotation-state"]', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(1200);
}

const onImage = (page: Page) =>
  page.getByTestId("annotation-state").evaluate((el: HTMLElement) => Number(el.dataset.onImage));

async function pick(page: Page, label: RegExp) {
  await page.getByRole("button", { name: "More measurement tools" }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 10 });
  await page.mouse.up();
}

/** Text the annotations draw (Cornerstone's SVG text boxes). */
const svgText = (page: Page) =>
  page.locator('[role="img"][aria-label^="DICOM viewer"] svg text').allTextContents().then((t) => t.join(" | "));

test("measure: Cobb angle, bidirectional, circle and freehand ROIs, magnifier", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openStudy(page);
  const image = page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
  await image.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(300);
  const b = (await image.boundingBox())!;
  const P = (fx: number, fy: number): [number, number] => [b.x + b.width * fx, b.y + b.height * fy];

  // The menu offers the desktop's set.
  await page.getByRole("button", { name: "More measurement tools" }).click();
  for (const name of [/^Cobb angle/, /^Bidirectional/, /^Circle ROI/, /^Freehand ROI/, /^Magnifying glass/]) {
    await expect(page.getByRole("menuitemradio", { name })).toBeVisible();
  }
  await page.keyboard.press("Escape");

  // Bidirectional from its key (D, as on the desktop): long and short axis.
  await image.focus();
  await page.keyboard.press("d");
  await expect(page.getByRole("button", { name: /^Bidirectional/ }).first()).toHaveAttribute("aria-pressed", "true");
  await drag(page, P(0.3, 0.3), P(0.45, 0.4));
  await expect.poll(() => onImage(page)).toBe(1);
  await expect.poll(() => svgText(page)).toMatch(/L:\s*[\d.]+\s*mm/);
  await expect.poll(() => svgText(page)).toMatch(/W:\s*[\d.]+\s*mm/);

  // Cobb angle: two lines, the angle between them.
  await pick(page, /^Cobb angle/);
  await drag(page, P(0.55, 0.25), P(0.75, 0.3));
  await drag(page, P(0.55, 0.45), P(0.75, 0.38));
  await expect.poll(() => onImage(page)).toBe(2);
  await expect.poll(() => svgText(page)).toMatch(/\d+(\.\d+)?\s*°/);

  // Circle ROI: centre, then radius; reads mean / area in HU and mm².
  await pick(page, /^Circle ROI/);
  await drag(page, P(0.6, 0.75), P(0.65, 0.75));
  await expect.poll(() => onImage(page)).toBe(3);
  await expect.poll(() => svgText(page)).toMatch(/Mean:.*HU/);

  // Freehand ROI: a closed loop, clear of the other shapes and their text boxes.
  await pick(page, /^Freehand ROI/);
  const loop: [number, number][] = [P(0.18, 0.58), P(0.28, 0.56), P(0.32, 0.66), P(0.24, 0.72), P(0.16, 0.66), P(0.18, 0.58)];
  await page.mouse.move(...loop[0]!);
  await page.mouse.down();
  for (const p of loop.slice(1)) await page.mouse.move(...p, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => onImage(page)).toBe(4);
  // Its own area and HU, beside the circle's (Cornerstone would leave a
  // freshly closed contour without stats: needsFreehandStats).
  await expect.poll(async () => (await svgText(page)).match(/Area:/g)?.length ?? 0).toBe(2);
  await expect.poll(async () => (await svgText(page)).match(/Mean:.*?HU/g)?.length ?? 0).toBe(2);

  // Magnifier: a loupe while the button is held, nothing left behind.
  await pick(page, /^Magnifying glass/);
  await page.mouse.move(...P(0.5, 0.5));
  await page.mouse.down();
  await page.mouse.move(...P(0.52, 0.52), { steps: 4 });
  await expect(page.locator(".magnifyTool")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".magnifyTool")).toHaveCount(0);
  expect(await onImage(page)).toBe(4);

  // The help sheet lists D.
  await page.keyboard.press("Shift+?");
  await expect(page.getByRole("dialog").getByText("Bidirectional")).toBeVisible();
  expect(errors).toEqual([]);
});
