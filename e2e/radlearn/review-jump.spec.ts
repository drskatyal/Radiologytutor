import { expect, test } from "@playwright/test";
import { authorReviewCase } from "../support/reviewFixture";
import { snapshot } from "../support/captureFixture";
import { matchesView } from "../../lib/journal/match";

test("M7 Jump confirms exact single-frame and multiframe identity, window, camera and invert; evidence seeks retained media", async ({ page, browser }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => request(time => {
      const delay = Number(sessionStorage.getItem("review-render-delay") || 0);
      if (delay) setTimeout(() => callback(performance.now()), delay); else callback(time);
    });
  });
  const { caseId, review } = await authorReviewCase(page);
  for (const row of review.findings) {
    const card = page.getByTestId(`finding-review-${row.finding.id}`);
    if (row.finding.id === "review-1") await page.evaluate(() => sessionStorage.setItem("review-render-delay", "650"));
    await card.getByRole("button", { name: "Jump", exact: true }).click();
    if (row.finding.id === "review-1") { await expect(card.getByRole("button", { name: "Waiting for render…" })).toBeDisabled(); await expect(card.getByText("Rendered ✓", { exact: true })).toHaveCount(0); }
    await expect(card.getByText("Rendered ✓", { exact: true })).toBeVisible().catch(async error => { console.error(JSON.stringify({ finding: row.finding.id, expected: row.snapshot, actual: await snapshot(page), error: await card.getByRole("alert").allTextContents() })); throw error; });
    expect(matchesView(await snapshot(page), row.snapshot!)).toBe(true);
    await page.evaluate(() => sessionStorage.removeItem("review-render-delay"));
  }
  expect(review.findings[2].snapshot!.sopUID).toBe(review.findings[3].snapshot!.sopUID);
  expect(review.findings[2].snapshot!.frame).toBe(2); expect(review.findings[3].snapshot!.frame).toBe(3);
  const first = page.getByTestId("finding-review-review-1");
  await first.getByText("Annotations and measurements (2)", { exact: true }).click();
  await expect(first.getByText("Synthetic diameter · 8.00 mm", { exact: true })).toBeVisible();
  await expect(first.getByText("PixelSpacing", { exact: true })).toHaveCount(2);
  await expect(first.getByText("Annotation 1: Synthetic contour", { exact: true })).toBeVisible();
  await first.getByRole("button", { name: /^Evidence / }).click();
  await expect.poll(async () => page.locator('audio[aria-label="Evidence audio"]').evaluate((el: HTMLAudioElement) => el.currentTime)).toBeCloseTo(.3, 2);
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(`/api/cases/${caseId}/review`)).status()).toBe(401);
  expect((await anonymous.request.post(`/api/cases/${caseId}/findings/review-1/review`, { data: { expectedVersion: 1, contentHash: "fake" } })).status()).toBe(401);
  expect((await anonymous.request.get(`/api/cases/${caseId}/capture-sessions/review-evidence/media?stream=audio`)).status()).toBe(401);
  await anonymous.close();
  await page.screenshot({ path: test.info().outputPath("finding-review.png"), fullPage: true });
});
