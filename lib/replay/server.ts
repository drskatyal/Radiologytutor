import { randomUUID } from 'node:crypto';
import { getCaseForOrg, mutateCase } from '../cases';
import { loadCaseReview } from '../review/server';
import { assertNoPhi, assertReviewedMedia } from '../phiGuard';
import { FindingConflict } from '../findingContent';
import { trackFromJournal } from '../journal/track';
import { validSnapshot } from '../journal/viewer';
import { matchesView } from '../journal/match';
import { replayPlan } from './plan';
import { ReplayError, type ReplayResult, type ReplayRun } from './types';
/** Author review only. Never expose this retained evidence through the exam projection. */
export async function approvedReplay(orgId: string, caseId: string, findingId: string) {
  const review = await loadCaseReview(orgId, caseId), row = review.findings.find(f => f.finding.id === findingId);
  if (!row) throw new FindingConflict('Finding not found', 404);
  if (!row.approved) throw new FindingConflict(row.reasons[0] ?? 'Approve the current finding version before replay.', 409);
  const capture = review.caseData.captureSessions?.find(c => c.id === row.finding.captureSessionId);
  if (!capture?.manifest || capture.manifest.status !== 'complete' || !capture.journal) throw new ReplayError('incomplete_capture', 'The complete original take is unavailable. Re-record before exact replay.');
  assertReviewedMedia(capture.manifest.phiReview); assertNoPhi(capture.journal);
  const track = trackFromJournal(capture.journal, capture.manifest), hasAudio = capture.manifest.chunks.some(c => c.stream === 'audio');
  replayPlan(track, hasAudio);
  return { track, findingId, version: row.version, contentHash: row.contentHash, captureSessionId: capture.id,
    audioUrl: hasAudio ? `/api/cases/${encodeURIComponent(caseId)}/capture-sessions/${encodeURIComponent(capture.id)}/media?stream=audio` : null };
}
/** Client render receipts are diagnostic evidence, never approval authority. */
export async function recordReplay(orgId: string, caseId: string, findingId: string, userId: string, body: {
  version: number; contentHash: string; captureSessionId: string; result: ReplayResult;
}): Promise<ReplayRun> {
  const data = await getCaseForOrg(orgId, caseId);
  if (!data) throw new FindingConflict('Case not found', 404);
  const capture = data.captureSessions?.find(c => c.id === body.captureSessionId);
  const version = data.findingVersions?.find(v => v.findingId === findingId && v.version === body.version && v.contentHash === body.contentHash);
  if (!version || version.content.captureSessionId !== capture?.id || !capture?.manifest || !capture.journal) throw new FindingConflict('Replay evidence changed. Reload before retrying.', 409);
  assertNoPhi(body);
  const result = body.result;
  if (!result || !['completed', 'failed', 'cancelled'].includes(result.outcome) || !Array.isArray(result.confirmations) || !Array.isArray(result.misses) || result.confirmations.length > capture.journal.length + 1 || result.misses.length > 1) throw new FindingConflict('Invalid replay receipt', 422);
  const initial = capture.journal.find(e => e.kind === 'render')!;
  for (const c of result.confirmations) {
    const expected = c.seq === null ? initial : capture.journal.find(e => e.seq === c.seq && ['render', 'layout'].includes(e.kind));
    if (!expected?.snapshot || c.t !== (c.seq === null ? 0 : expected.t) || !Number.isFinite(c.waitMs) || c.waitMs < 0 || !c.snapshot || !validSnapshot(c.snapshot) || !matchesView(c.snapshot, expected.snapshot)) throw new FindingConflict('Invalid render receipt', 422);
  }
  for (const m of result.misses) if (!Number.isFinite(m.t) || m.t < 0 || m.t > capture.durationMs || typeof m.code !== 'string' || m.code.length > 80 || typeof m.message !== 'string' || m.message.length > 500) throw new FindingConflict('Invalid replay miss', 422);
  const expectedSeq = [null, ...capture.journal.filter(e => ['render', 'layout'].includes(e.kind)).map(e => e.seq)];
  if (result.outcome === 'completed' && (result.misses.length || JSON.stringify(result.confirmations.map(c => c.seq)) !== JSON.stringify(expectedSeq))) throw new FindingConflict('Replay skipped a render', 422);
  const run: ReplayRun = { id: randomUUID(), findingId, version: body.version, contentHash: body.contentHash, captureSessionId: capture.id, recordedAt: new Date().toISOString(), recordedBy: userId,
    outcome: result.outcome, confirmations: result.confirmations.map(({ seq, t, snapshot, waitMs }) => ({ seq, t, snapshot, waitMs })), misses: result.misses.map(({ seq, t, code, message }) => ({ seq, t, code, message })) };
  await mutateCase(orgId, caseId, latest => { latest.replayRuns = [...(latest.replayRuns ?? []), run]; return latest; });
  return run;
}
