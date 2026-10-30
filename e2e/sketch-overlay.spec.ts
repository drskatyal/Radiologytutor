import { expect, test } from "@playwright/test";

async function openSketch(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("radlearn-cookie-ack", "1");
  });
  await page.goto("/dev/sketch");
}

test("desktop marks stay on the image point and hide off-slice", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSketch(page);
  const circle = page.getByTestId("sketch-circle");
  await expect(circle).toBeVisible();
  const imageX = await circle.getAttribute("data-image-x");
  const before = await circle.getAttribute("transform");
  expect(imageX).toBe("0.34");
  await expect(page.getByTestId("sketch-card")).toContainText("Spiculated nodule");
  await expect(page.getByTestId("sketch-arrow")).toBeVisible();
  await expect(page.getByTestId("sketch-underline")).toBeVisible();
  await page.getByRole("button", { name: "Replay marks" }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "/opt/cursor/artifacts/sketch-desktop.png", fullPage: false });
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(circle).toHaveAttribute("data-image-x", "0.34");
  const after = await circle.getAttribute("transform");
  expect(after).not.toBe(before);
  await page.screenshot({ path: "/opt/cursor/artifacts/sketch-desktop-zoom.png" });
  await page.getByRole("button", { name: "Other slice" }).click();
  await expect(page.getByTestId("sketch-circle")).toHaveCount(0);
  await page.screenshot({ path: "/opt/cursor/artifacts/sketch-desktop-offslice.png" });
});

test("phone card stays inside the viewport and 3D is labelled generic", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSketch(page);
  const card = page.getByTestId("sketch-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Spiculated nodule");
  const box = await card.boundingBox();
  const stage = await page.getByTestId("sketch-stage").boundingBox();
  expect(box).toBeTruthy();
  expect(stage).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(stage!.x - 1);
  expect(box!.y).toBeGreaterThanOrEqual(stage!.y - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
  await page.screenshot({ path: "/opt/cursor/artifacts/sketch-phone.png" });
  await page.getByRole("button", { name: "Show in 3D" }).click();
  await expect(page.getByTestId("anatomy-disclaimer")).toContainText("Not derived from this patient's CT");
  await expect(page.getByRole("button", { name: "Right lung" })).toBeVisible();
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "/opt/cursor/artifacts/sketch-phone-3d.png" });
});
