import { expect, test, type Page } from "@playwright/test";

// Runs against the LIDC-IDRI CT (scripts/serve_local_ct.py). Screenshots go to
// SKETCH_SHOTS_DIR when set.
const shots = process.env.SKETCH_SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function openNodule(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("radlearn-cookie-ack", "1");
  });
  const auth = await page.request.post("/api/auth/demo", { data: { role: "author" } });
  expect(auth.ok()).toBeTruthy();
  await page.goto("/case/case-lidc-nodule-search");
  await expect(page.getByTestId("sketch-card").first()).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: /next finding/i }).first().click();
  // The reader-annotated LIDC nodule: left upper lobe apex, stack index 6.
  await expect(page.getByTestId("sketch-stage")).toHaveAttribute("data-image-x", "0.68", { timeout: 30_000 });
  await expect(page.getByTestId("sketch-card")).toContainText("Peripheral nodule survey");
  await expect(page.locator('[data-testid="sketch-ring"][data-done="true"]')).toBeVisible();
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test("desktop: one ring on the nodule, a solid card in black space, clear of the controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNodule(page);
  await page.waitForTimeout(1600);
  const card = (await page.getByTestId("sketch-card").boundingBox())!;
  const ring = (await page.getByTestId("sketch-ring").boundingBox())!;
  const toolbar = (await page.getByRole("toolbar").first().boundingBox())!;
  const scrollbar = (await page.getByRole("slider", { name: "Slice" }).boundingBox())!;
  expect(overlaps(card, ring)).toBe(false);
  expect(overlaps(card, toolbar)).toBe(false);
  expect(overlaps(card, scrollbar)).toBe(false);
  // Exactly one stroke: no unrequested arrow next to the ring.
  await expect(page.getByTestId("sketch-arrow")).toHaveCount(0);
  await expect(page.getByTestId("sketch-connector")).toHaveCount(1);
  await shot(page, "ct-desktop-nodule");

  await page.getByRole("button", { name: "Show in 3D" }).click();
  await expect(page.getByTestId("anatomy-disclaimer")).toContainText("TotalSegmentator");
  const panel = (await page.getByTestId("anatomy-panel").boundingBox())!;
  expect(panel.width).toBeGreaterThanOrEqual(1440 - 1);
  expect(panel.height).toBeGreaterThanOrEqual(900 - 1);
  await expect(page.getByTestId("anatomy-finding-label")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3500);
  await shot(page, "ct-desktop-3d");
  await page.keyboard.press("Escape");
  // Software WebGL can hold the main thread for seconds per frame in CI.
  await expect(page.getByTestId("anatomy-panel")).toHaveCount(0, { timeout: 60_000 });
});

test("phone: the card stays on the image and the 3D view is full screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNodule(page);
  await page.waitForTimeout(1200);
  const card = (await page.getByTestId("sketch-card").boundingBox())!;
  const stage = (await page.getByTestId("sketch-stage").boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(stage.x - 1);
  expect(card.y).toBeGreaterThanOrEqual(stage.y - 1);
  expect(card.x + card.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
  expect(card.y + card.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
  await shot(page, "ct-phone-nodule");
  await page.getByRole("button", { name: "Show in 3D" }).click();
  const panel = (await page.getByTestId("anatomy-panel").boundingBox())!;
  expect(panel.height).toBeGreaterThanOrEqual(844 - 1);
  await page.waitForTimeout(3500);
  await shot(page, "ct-phone-3d");
});
