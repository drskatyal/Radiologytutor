import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The teaching-layer seam (lib/teachingLayer.ts) on the shared ViewerFrame,
// through the /dev/teaching-layer fixture: a two-finding tour on local files.
//  - the layer's overlay is drawn over the image (the finding marker);
//  - onViewer hands over a TeachingViewer that lands each finding (slice and
//    window), and the tour reads "Finding n of N";
//  - with a layer the frame keeps the teaching tool set (no Export), while the
//    free viewer without one keeps everything.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, route: string) {
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto(route);
  const files = fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible({ timeout: 30_000 });
}

const slice = async (page: Page) =>
  Number(await page.getByRole("slider", { name: "Slice" }).first().getAttribute("aria-valuenow"));

test("a teaching layer draws over the image and lands each finding of its tour", async ({ page }) => {
  await open(page, "/dev/teaching-layer");
  const position = page.getByTestId("tour-position");
  const marker = page.getByTestId("teaching-marker");

  // Landed on the first finding: a quarter in, lung window, marker drawn.
  await expect(position).toHaveText("Finding 1 of 2 · Lung window");
  await expect(marker).toBeVisible();
  await expect(page.getByText(/W 1500\s+L [−-]600/).first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => slice(page)).toBeLessThan(30);
  const firstMarker = (await marker.boundingBox())!;
  const canvas = (await page.locator("canvas").first().boundingBox())!;
  expect(firstMarker.x).toBeGreaterThan(canvas.x);
  expect(firstMarker.x + firstMarker.width).toBeLessThan(canvas.x + canvas.width);
  await expect(page.getByRole("button", { name: "Previous finding" })).toBeDisabled();

  // Next: three quarters in, soft-tissue window, the marker moves.
  await page.getByRole("button", { name: "Next finding" }).click();
  await expect(position).toHaveText("Finding 2 of 2 · Soft tissue");
  await expect(page.getByText(/W 400\s+L 40\b/).first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => slice(page)).toBeGreaterThan(30);
  await expect.poll(async () => (await marker.boundingBox())!.x).toBeGreaterThan(firstMarker.x + 50);
  await expect(page.getByRole("button", { name: "Next finding" })).toBeDisabled();

  // And back.
  await page.getByRole("button", { name: "Previous finding" }).click();
  await expect(position).toHaveText("Finding 1 of 2 · Lung window");
  await expect.poll(() => slice(page)).toBeLessThan(30);
});

test("with a layer the frame keeps the teaching tool set; the free viewer keeps everything", async ({ page }) => {
  await open(page, "/dev/teaching-layer");
  // A reading room: the viewer fills the screen under the tour bar, no app nav.
  await expect(page.getByRole("toolbar", { name: "Viewer tools" })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
  // Free-viewer upsell stays out of teaching.
  await expect(page.getByText("Keep this study?")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Export images/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Measurements \(list/ })).toHaveCount(0);

  await open(page, "/viewer");
  await expect(page.getByRole("button", { name: /^Export images/ })).toHaveCount(1);
  await expect(page.getByTestId("teaching-marker")).toHaveCount(0);
});
