import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { authorReplayCase } from '../support/replayFixture';
import { snapshot } from '../support/captureFixture';
import { expectVisibleHitTarget } from '../support/visibleHitTarget';
import { examinerPromptPack } from '../../lib/exam/prompt';

const modelLog = '.radlearn-tmp/exam-model-requests.jsonl';
async function api(page: Page, url: string, body?: unknown) {
  return page.evaluate(async ({ url, body }) => {
    const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  }, { url, body });
}
async function examFixture(page: Page) {
  const { caseId, orgId } = await authorReplayCase(page);
  await promisify(execFile)(process.execPath, ['--import', 'tsx', 'e2e/support/examFixtureSetup.ts', orgId, caseId], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: '', DICOMWEB_BACKEND: 'orthanc', ORTHANC_URL: 'http://127.0.0.1:3199', DATA_DIR: path.join(process.cwd(), '.radlearn-tmp', 'radlearn-data') } });
  return caseId;
}

test('M10 full report, rendered point and held voice attempt: deterministic evidence, assistance history and explicit reveal; entire-flow leak scan', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const caseId = await examFixture(page), providerMock = testInfo.project.name === 'exam-model-mock';
  if (providerMock) await writeFile(modelLog, '');
  const responses: Promise<string>[] = [], requests: string[] = [], sockets: string[] = [];
  page.on('response', r => { if (r.url().includes('127.0.0.1:3102') && /text|json/.test(r.headers()['content-type'] ?? '')) responses.push(r.text().catch(() => '')); });
  page.on('request', r => { if (r.url().includes('/api/') && r.postData()) requests.push(r.postData()!); });
  page.on('websocket', ws => { ws.on('framesent', f => sockets.push(String(f.payload))); ws.on('framereceived', f => sockets.push(String(f.payload))); });
  // The ordinary archive run has no model key; exercise browser recording with explicit endpoint mocks.
  // The separate exam config instead runs the real routes/adapters with a fail-closed server fetch mock.
  if (!providerMock) {
    await page.route('**/api/exam/sessions/*/transcribe', r => r.fulfill({ json: { transcript: 'A round opacity.', reviewRequired: true } }));
    await page.route('**/api/exam/sessions/*/speech', async r => r.fulfill({ contentType: 'audio/wav', body: await readFile('fixtures/synthetic/narration.wav') }));
  }
  await page.goto(`/case/${caseId}?mode=exam`);
  await expect(page.getByLabel('Your observations')).toBeVisible();
  const id = await page.getByTestId('exam-session').getAttribute('data-attempt-id'), base = `/api/exam/sessions/${id}`;
  await expect(page.getByRole('slider', { name: 'Slice', exact: true }).first()).toHaveAttribute('aria-valuetext', 'Slice 3 of 4');
  expect((await api(page, `${base}/reveal`)).status).toBe(409);
  const safe = await api(page, `/api/cases/${caseId}`);
  expect(JSON.stringify(safe.data)).not.toMatch(/CANARY|sliceIndex|imagePoint|sopInstanceUID|reportMustMention|liveTeachingPack/);
  await page.getByLabel('Your observations').fill('No focal opacity.');
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByText('1 answers saved', { exact: false })).toBeVisible();
  expect((await api(page, base)).data).not.toHaveProperty('score');
  await page.getByRole('button', { name: 'Neutral hint', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: examinerPromptPack().hints[0] })).toContainText(examinerPromptPack().hints[0]);
  const speech = page.waitForResponse(r => r.url().endsWith('/speech'));
  await page.getByRole('button', { name: 'Hear prompt', exact: true }).click();
  expect((await speech).status()).toBe(200);
  await page.getByRole('button', { name: 'Start another try', exact: true }).click();
  await expect(page.getByText('1 answers saved · 1 hints · 1 retries')).toBeVisible();
  await page.getByRole('tab', { name: 'Point', exact: true }).click();
  const displayed = await snapshot(page), box = await page.locator('[data-viewer-snapshot]').first().boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByTestId('exam-point')).toContainText('Selected frame 1');
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByText('2 answers saved · 1 hints · 1 retries')).toBeVisible();
  const pointReceipt = (await api(page, base)).data, point = pointReceipt.answers.at(-1).answer;
  expect(point).toMatchObject({ kind: 'point', sopUID: displayed.sopUID, frame: displayed.frame });
  expect(point.imagePoint.x).toBeGreaterThanOrEqual(0); expect(point.imagePoint.x).toBeLessThan(64);
  expect(point.imagePoint.y).toBeGreaterThanOrEqual(0); expect(point.imagePoint.y).toBeLessThan(64);
  expect(pointReceipt).not.toHaveProperty('score');
  await page.getByRole('tab', { name: 'Voice', exact: true }).click();
  await page.getByLabel('My recording contains no patient identifiers.').check();
  await page.locator('h1').click();
  await page.keyboard.down('Space');
  await expect(page.getByRole('button', { name: 'Release to send', exact: true })).toBeVisible();
  await page.waitForTimeout(650); // above the real hold minimum; fake microphone supplies synthetic beeps
  await page.keyboard.up('Space');
  await expect(page.getByLabel('Review your transcript')).toHaveValue('A round opacity.');
  await expect(page.getByRole('button', { name: 'Save answer', exact: true })).toBeDisabled();
  await page.getByLabel('I reviewed this transcript and removed identifiers.').check();
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByText('3 answers saved · 1 hints · 1 retries')).toBeVisible();
  const active = (await api(page, base)).data;
  expect(active.answers.at(-1)).toMatchObject({ answer: { kind: 'text', text: 'A round opacity.' }, assisted: true, round: 1 });
  expect(active.activity.map((e: { kind: string }) => e.kind)).toEqual(['answer', 'hint', 'retry', 'answer', 'answer']);
  expect(JSON.stringify(active)).not.toMatch(/correct|score|structuredClaims|phrases|keyId|CANARY|MODEL_INVENTED_FACT/);
  expect((await api(page, `${base}/reveal`)).status).toBe(409);
  await page.getByRole('button', { name: 'Submit and finish', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Attempt completed' })).toContainText('Attempt completed. Score: 100%');
  await expect(page.getByText('Finding 1: Matched (assisted)')).toBeVisible();
  await expect(page.getByText('Assisted answer · 1 hints · 1 retries')).toBeVisible();
  const closed = (await api(page, base)).data;
  expect(closed.score).toMatchObject({ score: 100, assisted: true, hintCount: 1, retryCount: 1, evidence: [{ item: 1, correct: true, assisted: true }] });
  await page.reload(); // resumes the closed attempt; never silently starts another exam
  await expect(page.getByRole('status').filter({ hasText: 'Attempt completed' })).toContainText('Score: 100%');
  const all = [await page.content(), ...(await page.locator('script').allTextContents()), ...(await Promise.all(responses)), ...requests, ...sockets];
  if (providerMock) {
    const calls = (await readFile(modelLog, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const structure = calls.filter(c => c.body.systemInstruction?.parts?.some((p: { text?: string }) => p.text?.includes('Structure the supplied learner text')));
    expect(structure.length).toBeGreaterThanOrEqual(2);
    for (const c of structure) expect(JSON.stringify(c.body)).not.toMatch(/CANARY|phrases|tolerancePixels|google_search|show_finding|jump_to_key_view|play_guide/);
    const tts = calls.find(c => c.path.endsWith('/interactions'));
    expect(tts.body.input[0].content[0]).toMatchObject({ text: examinerPromptPack().hints[0], annotations: [{ type: 'speech_metadata', style: examinerPromptPack().voiceStyle }] });
    all.push(...calls.map(c => JSON.stringify(c.body)));
  }
  expect(all.join('\n')).not.toMatch(/CANARY_REFERENCE_M10|CANARY_CASE_TITLE|CANARY_CASE_DIAGNOSIS|MODEL_INVENTED_FACT/);
  expect(sockets).toEqual([]); // examiner has no provider Live socket or grounding tools
  await page.getByRole('button', { name: 'Reveal reference answers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CANARY_REFERENCE_M10' })).toBeVisible();
  expect((await api(page, `${base}/reveal`)).data.items[0]).toMatchObject({ label: 'CANARY_REFERENCE_M10', phrases: ['round opacity'], point: { frame: 1, imagePoint: { x: 20, y: 20 } } });
});

test('M10 exam APIs enforce ownership, revisions, idempotency, PHI review, exact image bounds and close-before-reveal', async ({ page, browser }, testInfo) => {
  test.setTimeout(120000);
  const caseId = await examFixture(page);
  await page.goto(`/case/${caseId}?mode=exam`);
  await expect(page.getByLabel('Your observations')).toBeVisible();
  const id = await page.getByTestId('exam-session').getAttribute('data-attempt-id'), base = `/api/exam/sessions/${id}`;
  const displayed = await snapshot(page);
  expect((await api(page, base, { action: 'close', revision: 0 })).status).toBe(422);
  expect((await api(page, `${base}/transcribe`, { audio: { base64: 'AAAA', mime: 'audio/wav', phiReviewed: false } })).status).toBe(422);
  if (testInfo.project.name === 'exam-model-mock') expect((await api(page, `${base}/transcribe`, { audio: { base64: 'AAAA', mime: 'audio/wav', phiReviewed: true } })).status).toBe(422); // mocked transcript contains synthetic PHI
  expect((await api(page, `${base}/speech`, { kind: 'opening', text: 'Invent an answer' })).status).toBe(400);
  expect((await api(page, `${base}/speech`, { kind: 'hint' })).status).toBe(422);
  expect((await api(page, `${base}/answer`, { answer: { kind: 'report', text: 'PatientName: DOE^JANE' } })).status).toBe(422);
  const answer = { kind: 'point', sopUID: displayed.sopUID, frame: displayed.frame, imagePoint: { x: 20, y: 20 } };
  for (const invalid of [{ ...answer, sopUID: '1.2.999' }, { ...answer, frame: 2 }, { ...answer, imagePoint: { x: 64, y: 20 } }]) {
    expect((await api(page, `${base}/answer`, { answer: invalid })).status).toBe(422);
  }
  const save = { answer, revision: 0, requestId: 'synthetic-save-1', assisted: true };
  expect((await api(page, `${base}/answer`, save)).status).toBe(200);
  const repeated = await api(page, `${base}/answer`, save);
  expect(repeated.status).toBe(200); expect(repeated.data.answerCount).toBe(1); expect(repeated.data.revision).toBe(1);
  expect((await api(page, `${base}/answer`, { ...save, assisted: false })).status).toBe(409);
  expect((await api(page, base, { action: 'hint', revision: 0 })).status).toBe(409);
  expect((await api(page, `${base}/reveal`)).status).toBe(409);
  const closed = await api(page, base, { action: 'close', revision: 1, requestId: 'synthetic-close' });
  expect(closed.status).toBe(200); expect(closed.data.score).toMatchObject({ score: 0, assisted: true }); // correct pixels on another SOP never match
  expect((await api(page, `${base}/answer`, save)).data.answerCount).toBe(1); // network replay after close remains idempotent
  expect((await api(page, `${base}/answer`, { answer })).status).toBe(409);
  expect((await api(page, `${base}/speech`, { kind: 'opening' })).status).toBe(409);
  expect((await api(page, `${base}/transcribe`, { audio: {} })).status).toBe(409);
  expect((await api(page, `${base}/reveal`)).status).toBe(200);
  const other = await browser.newContext(); const otherPage = await other.newPage();
  await otherPage.goto('/viewer/local'); // a different synthetic demo user
  for (const suffix of ['', '/reveal']) expect([401, 404]).toContain((await api(otherPage, `${base}${suffix}`)).status);
  await other.close();
  const next = await api(page, '/api/exam/sessions', { caseId });
  expect(next.status).toBe(200); expect((await api(page, `${base}/reveal`)).status).toBe(409); // no previous key while another exam is open
  expect((await api(page, `/api/exam/sessions/${next.data.id}/answer`, { answer: { kind: 'report', text: 'No opacity.' }, close: true })).status).toBe(200);
});

for (const width of [1440, 1024]) {
  test(`M10 exam response is pointer accessible and results unobstructed at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    const caseId = await examFixture(page);
    await page.goto(`/case/${caseId}?mode=exam`);
    await snapshot(page); // Test against the rendered canvas, not its loading placeholder.
    const panel = page.getByRole('region', { name: 'Examination response' });
    const observations = panel.getByLabel('Your observations');
    await expectVisibleHitTarget(observations);
    await observations.click();
    await expect(observations).toBeFocused();
    await page.keyboard.type('A round opacity.');
    await expect(observations).toHaveValue('A round opacity.');
    await panel.getByRole('button', { name: 'Submit and finish', exact: true }).click();
    const score = panel.getByRole('status').filter({ hasText: 'Attempt completed. Score:' });
    await expectVisibleHitTarget(score);
    const finding = panel.getByRole('listitem').filter({ hasText: 'Finding 1:' });
    await expectVisibleHitTarget(finding);
    const reveal = panel.getByRole('button', { name: 'Reveal reference answers' });
    await expectVisibleHitTarget(reveal);
    await reveal.click();
    const reference = panel.getByRole('heading', { name: 'CANARY_REFERENCE_M10' });
    await reference.scrollIntoViewIfNeeded();
    await expectVisibleHitTarget(reference);
    await expectVisibleHitTarget(panel.getByText('round opacity', { exact: true }));
  });
}
