import { expect, test } from "@playwright/test";

test("synthetic study loads real Cornerstone pixels in the case viewer", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("radlearn-cookie-ack", "1"));
  const frames: number[] = [];
  page.on("response", response => {
    if (/\/api\/dicomweb\/.*\/frames\/\d+/.test(response.url())) frames.push(response.status());
  });
  await page.goto("/case/case-synthetic-teach?mode=view");
  await expect(page.getByRole("heading", { name: "Synthetic teaching study", level: 1 })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Slice" }).first()).toBeVisible();
  await expect.poll(() => frames.filter(status => status === 200).length).toBeGreaterThan(0);
  await expect(page.locator("canvas").first()).toBeVisible();
});
