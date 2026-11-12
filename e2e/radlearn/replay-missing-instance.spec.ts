import { expect, test } from "@playwright/test";
import { authorReviewCase } from "../support/reviewFixture";
import { snapshot } from "../support/captureFixture";
import { authorReplayCase, replayRuns, replayState } from "../support/replayFixture";

test("M7 T3 review jump fails closed for a missing SOP without nearest-slice substitution (timed replay remains M8)", async ({ page }) => {
  const { review } = await authorReviewCase(page), target = review.findings[0].snapshot!;
  await page.route("**/api/dicomweb/**/metadata", async route => {
    if (!/\/series\/[^/]+\/metadata$/.test(new URL(route.request().url()).pathname)) return route.continue();
    const response = await route.fetch(); const rows = await response.json();
    return route.fulfill({ response, json: rows.filter((r: Record<string, { Value: string[] }>) => r["00080018"].Value[0] !== target.sopUID) });
  });
  await page.reload();
  const card = page.getByTestId("finding-review-review-1");
  await expect(card.getByRole("button", { name: "Jump", exact: true })).toBeEnabled();
  const before = await snapshot(page);
  await card.getByRole("button", { name: "Jump", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Image not found: rebind");
  await expect(card.getByText("Rendered ✓")).toHaveCount(0);
  const after = await snapshot(page); expect(after.sopUID).toBe(before.sopUID); expect(after.frame).toBe(before.frame);
});

test('M8 T3 timed replay stops at missing SOP; no nearest-slice substitute and no subsequent render', async ({ page }) => {
  const { caseId, panel } = await authorReplayCase(page, 'missing');
  await panel.getByRole('button', { name: 'Start exact replay' }).click();
  await expect(panel.getByRole('alert')).toContainText('Image not found: rebind');
  await expect(panel).toContainText('Replay receipt saved.');
  const run = (await replayRuns(page, caseId))[0];
  expect(run.outcome).toBe('failed'); expect(run.misses[0].seq).toBe(3); expect(run.confirmations.map(c => c.seq)).toEqual([null, 0]);
  expect((await replayState(page))!.elapsedMs).toBe(1800);
  expect((await snapshot(page)).sopUID).toBe(run.confirmations.at(-1)!.snapshot.sopUID);
});
