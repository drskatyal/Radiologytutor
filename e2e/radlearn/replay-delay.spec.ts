import { expect, test } from '@playwright/test';
import { authorReplayCase, replayState, replayRuns } from '../support/replayFixture';
test('M8 T10 delayed real image load holds timeline then resumes; timeout records a miss and never continues', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => request(time => { const delay = Number(sessionStorage.getItem('synthetic-render-delay') || 0); if (delay) setTimeout(() => callback(performance.now()), delay); else callback(time); });
  });
  const { caseId, panel } = await authorReplayCase(page);
  await page.evaluate(() => sessionStorage.setItem('synthetic-render-delay', '800'));
  await panel.getByRole('button', { name: 'Start exact replay' }).click();
  await expect.poll(async () => (await replayState(page))?.phase).toBe('waiting');
  const elapsed = (await replayState(page))!.elapsedMs;
  await page.waitForTimeout(250); expect((await replayState(page))!.elapsedMs).toBe(elapsed);
  await expect(panel).toContainText('Exact replay complete.', { timeout: 20000 });
  await expect(panel).toContainText('Replay receipt saved.');
  const completed = (await replayRuns(page, caseId))[0]; expect(completed.outcome).toBe('completed'); expect(completed.confirmations.some(c => c.waitMs >= 700)).toBe(true);
  await page.evaluate(() => sessionStorage.setItem('synthetic-render-delay', '6500'));
  await panel.getByRole('button', { name: 'Replay again' }).click();
  await expect.poll(async () => (await replayState(page))?.phase, { timeout: 10000 }).toBe('failed');
  await expect(panel.getByRole('alert')).toContainText(/render|confirmed/);
  await expect.poll(async () => (await replayRuns(page, caseId)).length).toBe(2);
  const failed = (await replayRuns(page, caseId))[1]; expect(failed.outcome).toBe('failed'); expect(failed.confirmations).toHaveLength(0); expect(failed.misses).toHaveLength(1);
  await page.evaluate(() => sessionStorage.removeItem('synthetic-render-delay'));
  await page.waitForTimeout(2000); expect((await replayState(page))!.phase).toBe('failed');
});
