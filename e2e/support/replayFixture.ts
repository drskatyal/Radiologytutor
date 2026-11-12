import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { authorCaptureCase, snapshot } from './captureFixture';
import type { ReplayState, ReplayRun } from '../../lib/replay/types';
export async function authorReplayCase(page: Page, mode = 'normal') {
  const { caseId, orgId } = await authorCaptureCase(page), view = await snapshot(page);
  await promisify(execFile)(process.execPath, ['--import', 'tsx', 'e2e/support/replayFixtureSetup.ts', orgId, caseId, JSON.stringify(view), mode], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: '', DICOMWEB_BACKEND: 'orthanc', ORTHANC_URL: `http://127.0.0.1:${process.env.MOCK_ARCHIVE_PORT ?? 3199}`, DATA_DIR: path.join(process.cwd(), '.radlearn-tmp', 'radlearn-data') } });
  await page.goto(`/studio/cases/${caseId}`);
  const card = page.getByTestId('finding-review-replay-one');
  await expect(card.getByRole('button', { name: 'Replay approved take', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Replay approved take', exact: true }).click();
  return { caseId, orgId, panel: page.getByRole('region', { name: 'Exact replay', exact: true }) };
}
export async function replayState(page: Page): Promise<ReplayState | null> { return JSON.parse((await page.locator('[data-replay-state]').getAttribute('data-replay-state'))!); }
export async function replayRuns(page: Page, caseId: string): Promise<ReplayRun[]> { return (await (await page.request.get(`/api/cases/${caseId}`)).json()).replayRuns ?? []; }
