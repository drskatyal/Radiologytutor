import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { authorReplayCase } from '../support/replayFixture';
import { snapshot } from '../support/captureFixture';
import type { ViewerSnapshot } from '../../lib/journal/types';

type Trace = { type: string; t: number; snapshot?: ViewerSnapshot };
async function trace(page: Page): Promise<Trace[]> { return page.evaluate(() => (window as any).__tutorTrace); }
async function setup(page: Page, answer = 'Compare the synthetic contour.') {
  await page.addInitScript(() => {
    const trace: unknown[] = []; (window as any).__tutorTrace = trace;
    const view = () => JSON.parse(document.querySelector('[data-viewer-snapshot]')?.getAttribute('data-viewer-snapshot') || 'null');
    const play = HTMLMediaElement.prototype.play, pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function () { trace.push({ type: 'play', t: performance.now(), snapshot: view() }); return play.call(this); };
    HTMLMediaElement.prototype.pause = function () { trace.push({ type: 'pause', t: performance.now(), snapshot: view() }); return pause.call(this); };
    window.addEventListener('radlearn:tutor', e => trace.push({ ...(e as CustomEvent).detail, t: performance.now() }));
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => request(time => {
      const delay = Number(sessionStorage.getItem('synthetic-render-delay') || 0);
      if (delay) setTimeout(() => callback(performance.now()), delay); else callback(time);
    });
  });
  const { caseId, orgId } = await authorReplayCase(page);
  await promisify(execFile)(process.execPath, ['--import', 'tsx', 'e2e/support/tutorFixtureSetup.ts', orgId, caseId], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: '', DATA_DIR: path.join(process.cwd(), '.radlearn-tmp', 'radlearn-data') } });
  const response = await page.request.get(`/api/cases/${caseId}/approved-tools`);
  expect(response.status()).toBe(200);
  const catalog = await response.json();
  expect(catalog.anchors).toHaveLength(1);
  let transcriptions = 0, plans = 0;
  const wav = await readFile('fixtures/synthetic/narration.wav');
  await page.route('**/api/transcribe', async route => {
    const body = route.request().postDataJSON(); expect(body.audio.phiReviewed).toBe(true); expect(body.audio.base64.length).toBeGreaterThan(100);
    transcriptions++; await route.fulfill({ json: { transcript: 'Describe the synthetic contour.' } });
  });
  await page.route('**/api/tutor', async route => {
    plans++; await route.fulfill({ json: { answer, approvalIds: catalog.anchors.map((a: { id: string }) => a.id), actions: [
      { type: 'show_finding', findingId: 'replay-one' }, { type: 'set_window', windowWidth: 800, windowCenter: 80 }, { type: 'set_zoom', zoom: 1.7 },
    ], sources: [] } });
  });
  await page.route('**/api/tts', route => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto(`/case/${caseId}?mode=teach`);
  await expect(page.locator('[data-viewer-snapshot]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hold to ask', exact: true }).last()).toBeEnabled();
  await page.getByLabel('My question contains no patient identifiers.').check();
  // Leave the target image: every subsequent acknowledgement comes from the real renderer.
  const slider = page.getByRole('slider', { name: 'Slice', exact: true }).first();
  await slider.focus(); await slider.press('End');
  await expect.poll(async () => (await snapshot(page)).sopUID).not.toBe(catalog.anchors[0].target.sopUID);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); (window as any).__tutorTrace.length = 0; });
  return { caseId, catalog, counts: () => ({ transcriptions, plans }) };
}
async function ask(page: Page) {
  await page.keyboard.down('Space');
  await expect(page.locator('[data-tutor-status]')).toContainText('Listening');
  await page.waitForTimeout(350);
  await page.keyboard.up('Space');
}

test('M9/P0-8 held STT then plan: every action is rendered sequentially before audio.play', async ({ page }) => {
  test.setTimeout(120000);
  const { catalog, counts } = await setup(page);
  await page.evaluate(() => sessionStorage.setItem('synthetic-render-delay', '350'));
  await page.keyboard.down('Space'); await page.keyboard.down('Space');
  await expect(page.locator('[data-tutor-status]')).toContainText('Listening');
  await page.waitForTimeout(400); expect(counts()).toEqual({ transcriptions: 0, plans: 0 });
  await page.keyboard.up('Space');
  await expect.poll(async () => (await trace(page)).filter(e => e.type === 'play').length, { timeout: 20000 }).toBe(1);
  expect(counts()).toEqual({ transcriptions: 1, plans: 1 });
  const events = await trace(page), rendered = events.filter(e => e.type === 'rendered'), play = events.find(e => e.type === 'play')!;
  expect(rendered).toHaveLength(3);
  expect(rendered.map(e => e.snapshot!.voi.ww)).toEqual([1500, 800, 800]);
  expect(rendered.map(e => e.snapshot!.camera.zoom)).toEqual([1.2, 1.2, 1.7]);
  expect(play.t).toBeGreaterThan(rendered[2].t);
  expect(play.snapshot!.sopUID).toBe(catalog.anchors[0].target.sopUID); expect(play.snapshot!.frame).toBe(1);
  expect(play.snapshot!.voi).toEqual({ ww: 800, wc: 80 }); expect(play.snapshot!.camera.zoom).toBe(1.7);
  // Barge-in during real audio: stop it immediately; Escape discards this second recording.
  await page.keyboard.down('Space');
  await expect.poll(async () => (await trace(page)).some(e => e.type === 'pause' && e.t > play.t)).toBe(true);
  await page.keyboard.press('Escape'); await page.keyboard.up('Space');
  await page.waitForTimeout(4500); expect((await trace(page)).filter(e => e.type === 'play')).toHaveLength(1); expect(counts().plans).toBe(1);
});

test('M9 cancellation during a delayed render cannot release stale audio or later actions', async ({ page }) => {
  test.setTimeout(120000); const { counts } = await setup(page);
  await page.evaluate(() => sessionStorage.setItem('synthetic-render-delay', '1800'));
  await ask(page);
  await expect(page.locator('[data-tutor-status]')).toContainText('Waiting for the approved image');
  await page.keyboard.down('Space'); await page.keyboard.press('Escape'); await page.keyboard.up('Space');
  await page.waitForTimeout(6000);
  expect((await trace(page)).filter(e => e.type === 'play')).toHaveLength(0);
  expect((await trace(page)).filter(e => e.type === 'rendered')).toHaveLength(0);
  expect(counts()).toEqual({ transcriptions: 1, plans: 1 });
});

test('M9 command API rejects missing, numeric, foreign, anonymous and examination authority', async ({ page, request }) => {
  test.setTimeout(120000); const { caseId } = await setup(page);
  const url = `/api/cases/${caseId}/tutor-commands`;
  expect((await request.post(url, { data: { command: { type: 'show_finding', findingId: 'replay-one' } } })).status()).toBe(401);
  for (const command of [{ type: 'point_to', x_pct: .5, y_pct: .5 }, { type: 'show_finding', findingId: 'missing' }, { type: 'show_anchor', anchorId: 'foreign/v1' }, { type: 'zoom', zoom: 500 }]) {
    expect((await page.request.post(url, { data: { command } })).status()).toBe(422);
  }
  expect((await page.request.post(url, { data: { command: { type: 'show_finding', findingId: 'replay-one' } } })).status()).toBe(200);
  await page.goto(`/case/${caseId}?mode=exam`); await expect(page.getByTestId('exam-session')).toBeVisible();
  expect((await page.request.post(url, { data: { command: { type: 'show_finding', findingId: 'replay-one' } } })).status()).toBe(403);
  // Close this attempt: the local author session is reused by later specs.
  await page.getByLabel('Your observations').fill('Synthetic test completed.');
  await page.getByRole('button', { name: 'Submit and finish' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Attempt completed' })).toBeVisible();
});

test('M9 barge-in during the first speech beat drops every remaining command and audio beat', async ({ page }) => {
  test.setTimeout(120000); await setup(page, 'First synthetic observation. Second synthetic observation.');
  await ask(page);
  await expect.poll(async () => (await trace(page)).filter(e => e.type === 'play').length).toBe(1);
  expect((await trace(page)).filter(e => e.type === 'rendered')).toHaveLength(1);
  await page.keyboard.down('Space'); await page.keyboard.press('Escape'); await page.keyboard.up('Space');
  await page.waitForTimeout(4500);
  expect((await trace(page)).filter(e => e.type === 'rendered')).toHaveLength(1);
  expect((await trace(page)).filter(e => e.type === 'play')).toHaveLength(1);
});

test('M9/T9 an edit while rendering invalidates the planned approval and blocks all speech', async ({ page }) => {
  test.setTimeout(120000); const { caseId, catalog } = await setup(page);
  await page.evaluate(() => sessionStorage.setItem('synthetic-render-delay', '1200'));
  await ask(page); await expect(page.locator('[data-tutor-status]')).toContainText('Waiting for the approved image');
  const edit = await page.request.post(`/api/cases/${caseId}/findings/replay-one/versions`, { data: { expectedVersion: 1, patch: { description: 'Revised synthetic contour' } } });
  expect(edit.status()).toBe(200);
  await expect(page.locator('[data-tutor-status]')).toContainText('no current approved image', { timeout: 15000 });
  expect((await trace(page)).filter(e => e.type === 'play')).toHaveLength(0);
  expect((await page.request.post(`/api/cases/${caseId}/tutor-commands`, { data: { command: { type: 'show_anchor', anchorId: catalog.anchors[0].id } } })).status()).toBe(422);
});

test('M9 a manual viewer scroll overrides speech and its remaining actions', async ({ page }) => {
  test.setTimeout(120000); await setup(page, 'First synthetic observation. Second synthetic observation.');
  await ask(page);
  await expect.poll(async () => (await trace(page)).filter(e => e.type === 'play').length).toBe(1);
  const before = await snapshot(page);
  await page.locator('[data-viewer-snapshot]').first().hover(); await page.mouse.wheel(0, 160);
  await expect.poll(async () => (await snapshot(page)).sopUID).not.toBe(before.sopUID);
  await page.waitForTimeout(4500);
  expect((await trace(page)).filter(e => e.type === 'play')).toHaveLength(1);
  expect((await trace(page)).filter(e => e.type === 'rendered')).toHaveLength(1);
});
