import { expect, test } from '@playwright/test';
import { authorReviewCase } from '../support/reviewFixture';
import { snapshot } from '../support/captureFixture';
import { matchesView } from '../../lib/journal/match';

test('approval requires an exact session render, keeps it for text edits, and drops it for changed anchor geometry', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    // Delay the actual renderer; do not invent a render acknowledgment.
    window.requestAnimationFrame = callback => request(time => {
      const delay = Number(sessionStorage.getItem('review-render-delay') || 0);
      if (delay) setTimeout(() => callback(performance.now()), delay); else callback(time);
    });
  });
  const { caseId, review } = await authorReviewCase(page);
  const card = page.getByTestId('finding-review-review-2');
  const rendered = card.getByText('Rendered ✓', { exact: true });
  for (const label of ['Images contain no patient identifiers', 'Audio contains no patient identifiers', 'Screen recording contains no patient identifiers']) await card.getByLabel(label).check();
  await card.getByRole('button', { name: 'Save new version', exact: true }).click();
  const approve = card.getByRole('button', { name: 'Approve v2', exact: true });
  await expect(approve).toBeDisabled();
  await expect(card.getByText('Jump to confirm the image first', { exact: true })).toBeVisible();
  await expect(rendered).toHaveCount(0);
  await page.evaluate(() => sessionStorage.setItem('review-render-delay', '650'));
  await card.getByRole('button', { name: 'Jump', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Waiting for render…' })).toBeDisabled();
  await expect(approve).toBeDisabled();
  await expect(rendered).toHaveCount(0);
  await expect(rendered).toBeVisible();
  expect(matchesView(await snapshot(page), review.findings[1].snapshot!)).toBe(true);
  await page.evaluate(() => sessionStorage.removeItem('review-render-delay'));
  await expect(approve).toBeEnabled();
  await card.getByLabel('Description', { exact: true }).fill('Expert text-only correction of the synthetic contour.');
  await expect(approve).toBeDisabled(); // Dirty gating still applies.
  await card.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Approve v3', exact: true })).toBeEnabled();
  await expect(rendered).toBeVisible();

  // Same SOP/frame/view, different point: a boolean or SOP-only cache would wrongly retain confirmation.
  const before = await snapshot(page);
  await card.getByRole('button', { name: 'Rebind anchor', exact: true }).click();
  await card.getByRole('button', { name: 'Use current view and centre point' }).click();
  await expect(card.getByRole('button', { name: 'Approve v4', exact: true })).toBeDisabled();
  await expect(card.getByText('Saved v4. Needs review.', { exact: true })).toBeVisible();
  await expect(rendered).toHaveCount(0);
  await expect(card.getByText('Jump to confirm the image first', { exact: true })).toBeVisible();
  const updated = await (await page.request.get(`/api/cases/${caseId}/review`)).json();
  const row = updated.findings.find((r: { finding: { id: string } }) => r.finding.id === 'review-2');
  expect(row.snapshot.sopUID).toBe(before.sopUID);
  expect(row.snapshot.frame).toBe(before.frame);
  expect(row.finding.resolvedAnchor.imagePoint).not.toEqual(review.findings[1].finding.resolvedAnchor!.imagePoint);
  await card.getByRole('button', { name: 'Jump', exact: true }).click();
  await expect(rendered).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve v4', exact: true })).toBeEnabled();

  // A different confirmed multiframe target invalidates the original card's session confirmation.
  const other = page.getByTestId('finding-review-review-3');
  await other.getByRole('button', { name: 'Jump', exact: true }).click();
  await expect(other.getByText('Rendered ✓', { exact: true })).toBeVisible();
  await expect(rendered).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Approve v4', exact: true })).toBeDisabled();
  await page.reload(); // Session evidence is never persisted as an approval shortcut.
  await expect(card.getByRole('button', { name: 'Approve v4', exact: true })).toBeDisabled();
  await expect(card.getByText('Jump to confirm the image first', { exact: true })).toBeVisible();
});
