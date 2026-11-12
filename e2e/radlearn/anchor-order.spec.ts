import { expect, test } from "@playwright/test";
import { authorReviewCase } from "../support/reviewFixture";
import { snapshot } from "../support/captureFixture";
import { matchesView } from "../../lib/journal/match";
test("M7 T1 reordered archive stack still jumps to the same named SOP/frame and recorded view", async ({ page }) => {
  const { review } = await authorReviewCase(page);
  const card = page.getByTestId("finding-review-review-1"), slider = page.getByRole("slider", { name: "Slice", exact: true }).first();
  await card.getByRole("button", { name: "Jump", exact: true }).click(); await expect(card.getByText("Rendered ✓")).toBeVisible();
  const before = await slider.getAttribute("aria-valuetext");
  await page.route("**/api/dicomweb/**/metadata", async route => {
    if (!/\/series\/[^/]+\/metadata$/.test(new URL(route.request().url()).pathname)) return route.continue();
    const response = await route.fetch(); const rows = await response.json();
    return route.fulfill({ response, json: rows.reverse() });
  });
  await page.reload(); await expect(card.getByRole("button", { name: "Jump", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "Jump", exact: true }).click(); await expect(card.getByText("Rendered ✓")).toBeVisible();
  expect(matchesView(await snapshot(page), review.findings[0].snapshot!)).toBe(true);
  expect(await slider.getAttribute("aria-valuetext")).not.toBe(before);
});
