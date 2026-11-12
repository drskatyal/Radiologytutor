import { expect, test } from "@playwright/test";
import { authorReviewCase } from "../support/reviewFixture";
import { snapshot } from "../support/captureFixture";

test("M7 T2 index-only finding cannot jump or approve; explicit rendered rebind creates a new exact version", async ({ page }) => {
  const { caseId } = await authorReviewCase(page);
  const changed = await page.request.post(`/api/cases/${caseId}/findings/review-1/versions`, { data: { expectedVersion: 1, patch: { sopInstanceUID: null } } });
  expect(changed.status()).toBe(200); await page.getByRole("button", { name: "Refresh review" }).click();
  const card = page.getByTestId("finding-review-review-1");
  await expect(card.getByText("Incomplete image anchor")).toBeVisible();
  await expect(card.getByRole("button", { name: "Jump", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Approve v2" })).toBeDisabled();
  const shown = await snapshot(page);
  await card.getByRole("button", { name: "Rebind anchor", exact: true }).click();
  await card.getByRole("button", { name: "Use current view and centre point" }).click();
  await expect(card.getByText("Saved v3. Needs review.")).toBeVisible();
  const data = await (await page.request.get(`/api/cases/${caseId}/review`)).json();
  const row = data.findings.find((r: { finding: { id: string } }) => r.finding.id === "review-1");
  expect(row.snapshot.sopUID).toBe(shown.sopUID); expect(row.snapshot.frame).toBe(shown.frame);
  expect(row.finding.expertReview.kind).toBe("rebind"); expect(row.finding.resolvedAnchor.imagePoint.x).toBeGreaterThanOrEqual(0);
  expect(row.versions).toHaveLength(3);
});
