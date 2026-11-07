import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Free viewer (/viewer): with "W/L" linked, a window change in one pane
// (drag or preset) follows in the others of the same modality; with "Zoom"
// linked, zoom follows on the same plane. Both off by default, like the
// desktop. Synthetic multi-series CT only.

const DIR = process.env.TEST_MULTI_DIR;
test.skip(!DIR, "TEST_MULTI_DIR is not set (scripts/make-test-multiseries.py)");

async function sideBySide(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: "Side by side layout" }).click();
  await expect(page.getByRole("slider", { name: "Slice" })).toHaveCount(2, { timeout: 30_000 });
  await page.waitForTimeout(800);
}

const pane = (page: Page, i: number) => page.getByTestId("viewer-pane").nth(i);
const text = (page: Page, i: number) => pane(page, i).innerText();
const zoomOf = async (page: Page, i: number) => Number((/Zoom (\d+)%/.exec(await text(page, i)) ?? [])[1]);

test("W/L: off by default; linked, a preset and a drag in one pane follow in the other", async ({ page }) => {
  test.setTimeout(120_000);
  await sideBySide(page);
  const wl = page.getByRole("button", { name: "Link window / level" });
  await expect(wl).toHaveAttribute("aria-pressed", "false");

  // Unlinked: lung in pane 1 leaves pane 2 alone.
  await pane(page, 0).click({ position: { x: 80, y: 80 } });
  await page.keyboard.press("1");
  await expect.poll(() => text(page, 0)).toMatch(/W 1500 L [-−]600/);
  expect(await text(page, 1)).not.toMatch(/W 1500 L [-−]600/);

  // Linked: bone in pane 1 shows in pane 2.
  await wl.click();
  await expect(wl).toHaveAttribute("aria-pressed", "true");
  await pane(page, 0).click({ position: { x: 80, y: 80 } });
  await page.keyboard.press("2");
  await expect.poll(() => text(page, 1)).toMatch(/W 2500 L 480/);

  // A right-drag window in pane 2 comes back to pane 1.
  const box = (await pane(page, 1).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 6 });
  await page.mouse.up({ button: "right" });
  const w2 = /W (\d+) L ([-−]?\d+)/.exec(await text(page, 1));
  expect(w2).not.toBeNull();
  await expect.poll(async () => /W (\d+) L ([-−]?\d+)/.exec(await text(page, 0))?.[0]).toBe(w2![0]);
});

test("Zoom: linked, zooming one pane zooms the other on the same plane", async ({ page }) => {
  test.setTimeout(120_000);
  await sideBySide(page);
  const zoom = page.getByRole("button", { name: "Link zoom and pan" });
  await expect(zoom).toHaveAttribute("aria-pressed", "false");
  await zoom.click();
  const before = await zoomOf(page, 1);
  await pane(page, 0).click({ position: { x: 80, y: 80 } });
  for (let k = 0; k < 3; k += 1) await page.keyboard.press("=");
  await expect.poll(() => zoomOf(page, 0)).toBeGreaterThan(before);
  await expect.poll(async () => (await zoomOf(page, 1)) === (await zoomOf(page, 0))).toBe(true);
});
