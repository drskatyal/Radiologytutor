import { expect, test, type Page } from "@playwright/test";

async function openCase(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("radlearn-cookie-ack", "1");
  });
  const auth = await page.request.post("/api/auth/demo", { data: { role: "author" } });
  expect(auth.ok()).toBeTruthy();
  await page.goto("/case/case-lidc-nodule-search");
  await expect(page.getByTestId("sketch-stage")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("sketch-card")).toContainText("Lung window");
}

test("desktop sketch sits on the real chest CT", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openCase(page);
  await page.waitForTimeout(1400);
  const imageX = await page.getByTestId("sketch-stage").getAttribute("data-image-x");
  expect(imageX).toBe("0.52");
  await page.screenshot({ path: "/opt/cursor/artifacts/ct-desktop.png" });
  await page.getByRole("button", { name: "Show in 3D" }).click();
  await expect(page.getByTestId("anatomy-disclaimer")).toContainText("TotalSegmentator");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: "/opt/cursor/artifacts/ct-desktop-3d.png" });
  await page.getByRole("button", { name: "Exploded view" }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "/opt/cursor/artifacts/ct-desktop-exploded.png" });
});

test("phone keeps the CT on screen and the 3D view in a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCase(page);
  await page.waitForTimeout(900);
  const card = page.getByTestId("sketch-card");
  const stage = page.locator(".bg-imaging").first();
  const cardBox = await card.boundingBox();
  const stageBox = await stage.boundingBox();
  expect(cardBox && stageBox).toBeTruthy();
  expect(cardBox!.y).toBeGreaterThanOrEqual(stageBox!.y - 2);
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(stageBox!.y + stageBox!.height + 2);
  await page.screenshot({ path: "/opt/cursor/artifacts/ct-phone.png" });
  await page.getByRole("button", { name: "Show in 3D" }).click();
  await expect(page.getByTestId("anatomy-disclaimer")).toContainText("TotalSegmentator");
  const panel = page.getByTestId("anatomy-panel");
  const panelBox = await panel.boundingBox();
  expect(panelBox).toBeTruthy();
  expect(panelBox!.height).toBeLessThan(844 * 0.6);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: "/opt/cursor/artifacts/ct-phone-3d.png" });
});
