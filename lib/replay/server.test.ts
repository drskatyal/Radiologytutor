import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { journalTestView } from '../journal/fixtures';
import { newManifest } from '../journal/manifest';
import { trackFromJournal } from '../journal/track';
import { hashContent } from '../findingContent';
import type { Case, Finding, CaptureSession } from '../types';
import type { ReplayResult } from './types';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'replay-server-')); process.env.MONGODB_URI = '';
process.env.DICOMWEB_BACKEND = 'orthanc'; process.env.ORTHANC_URL = 'http://synthetic-archive.invalid';
const fixture = JSON.parse(readFileSync('fixtures/synthetic/case.json', 'utf8')) as Case;
const study = JSON.parse(readFileSync('fixtures/synthetic/study.json', 'utf8'));
const rows = study.instances.filter((i: { seriesUID: string }) => i.seriesUID === study.seriesUIDs[0]).map((i: { metadata: unknown }) => i.metadata);
const snapshot = { ...journalTestView, studyUID: study.studyUID, seriesUID: study.seriesUIDs[0], sopUID: study.instances[0].sopUID };
test('approved replay checks organization, current version/hash, reviewed retained media and journal; receipts never grant approval', async () => {
  const previous = global.fetch; global.fetch = async () => Response.json(rows);
  try {
    const store = await import('../cases'), review = await import('../review/server'), api = await import('./server');
    const org = 'replay-org', caseId = 'replay-case', findingId = 'one';
    const manifest = { ...newManifest(caseId, 'take-one'), status: 'complete' as const, durationMs: 1000, phiReview: { pixels: true, audio: true, screen: true } };
    const journal = [{ seq: 0, t: 150, kind: 'render' as const, renderSeq: snapshot.renderSeq, snapshot }];
    const capture: CaptureSession = { id: manifest.sessionId, durationMs: 1000, createdAt: manifest.createdAt, manifest, journal, track: trackFromJournal(journal, manifest) };
    await store.saveCase({ ...fixture, caseId, orgId: org, findings: [], captureSessions: [capture] });
    const base = { ...fixture.findings[0], id: findingId, captureSessionId: capture.id, phiReview: manifest.phiReview };
    await store.createFinding(org, caseId, { ...base, ...review.rebindPatch(base, { snapshot, imagePoint: { x: 10, y: 20 }, dimensions: [64, 64] }, rows) } as Finding);
    await assert.rejects(api.approvedReplay('wrong-org', caseId, findingId), /not found/);
    await assert.rejects(api.approvedReplay(org, caseId, findingId), /Approve/);
    let data = (await store.getCaseForOrg(org, caseId))!, version = data.findingVersions!.find(v => v.findingId === findingId)!;
    await store.approve(org, caseId, findingId, version.version, version.contentHash, { id: 'expert', membershipRole: 'author' });
    const source = await api.approvedReplay(org, caseId, findingId); assert.equal(source.version, 1); assert.equal(source.track.journal![0].t, 150); assert.equal(source.audioUrl, null);
    const result: ReplayResult = { outcome: 'completed', confirmations: [{ seq: null, t: 0, snapshot, waitMs: 4 }, { seq: 0, t: 150, snapshot, waitMs: 8 }], misses: [] };
    const body = { version: 1, contentHash: version.contentHash, captureSessionId: capture.id, result };
    const receipt = await api.recordReplay(org, caseId, findingId, 'expert', body); assert.equal(receipt.outcome, 'completed');
    await assert.rejects(api.recordReplay(org, caseId, findingId, 'expert', { ...body, result: { ...result, confirmations: result.confirmations.slice(0, 1) } }), /skipped a render/);
    await assert.rejects(api.recordReplay(org, caseId, findingId, 'expert', { ...body, result: { ...result, confirmations: [{ ...result.confirmations[0], snapshot: { ...snapshot, frame: 9 } }] } }), /Invalid render/);
    await store.mutateCase(org, caseId, data => { data.captureSessions![0].manifest!.phiReview.audio = false; return data; });
    await assert.rejects(api.approvedReplay(org, caseId, findingId), /PHI review/);
    await store.createVersion(org, caseId, findingId, { label: 'Expert text edit' }, { expectedVersion: 1, userId: 'expert' });
    await assert.rejects(api.approvedReplay(org, caseId, findingId), /Approve/);
    // A receipt of an earlier approved replay remains diagnostic, and cannot re-approve v2.
    await api.recordReplay(org, caseId, findingId, 'expert', body);
    data = (await store.getCaseForOrg(org, caseId))!; assert.notEqual(data.findings[0].approvedVersion, 2); assert.equal(data.replayRuns!.length, 2);
    assert.equal(hashContent(data.findingVersions![0].content), version.contentHash);
  } finally { global.fetch = previous; }
});
