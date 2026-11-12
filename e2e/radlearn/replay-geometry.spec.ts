import { expect, test } from '@playwright/test';
import { authorReplayCase, replayRuns } from '../support/replayFixture';
import type { ProjectedReplayShape } from '../../lib/replay/types';
import { patientToPixel } from '../../lib/anchors/geometry';
import { matchesView } from '../../lib/journal/match';
import { snapshot } from '../support/captureFixture';
test('M8 T8 exact replay restores named image pixels, patient mm, spacing provenance and the recorded view', async ({ page }) => {
  const { caseId, panel } = await authorReplayCase(page);
  await panel.getByRole('button', { name: 'Start exact replay' }).click();
  await expect(panel).toContainText('Exact replay complete.', { timeout: 15000 });
  await expect(panel).toContainText('Replay receipt saved.');
  const shapes = JSON.parse((await page.locator('[data-replay-geometry]').getAttribute('data-replay-geometry'))!) as ProjectedReplayShape[];
  const length = shapes.find(s => s.id === 'replay-length')!;
  expect(length.imagePoints).toEqual([{ x: 10, y: 20 }, { x: 20, y: 20 }]); expect(length.geometry.calibration).toBe('PixelSpacing'); expect(length.lengthMm).toBe(9);
  length.patientPoints.forEach((p, i) => expect(patientToPixel(p!, length.geometry)).toEqual(length.imagePoints[i]));
  expect(length.canvasPoints[1].x).not.toBe(length.imagePoints[1].x); // real viewport projection, not canvas-as-image coordinates
  expect(matchesView(await snapshot(page), length.snapshot)).toBe(true);
  const run = (await replayRuns(page, caseId))[0]; expect(run.confirmations.map(c => c.t)).toEqual([0, 150, 1800, 2800]); expect(run.misses).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath('exact-replay-geometry.png'), fullPage: true });
});
