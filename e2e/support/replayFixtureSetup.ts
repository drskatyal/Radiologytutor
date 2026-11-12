// Local synthetic journal/media fixtures for M8. Never run against a remote store.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createFinding, approve, getCaseForOrg } from '../../lib/cases';
import { rebindPatch } from '../../lib/review/server';
import { startCapture, putCaptureChunk, completeCapture, reviewCapture } from '../../lib/journal/storage';
import { resolveAnchor } from '../../lib/anchors/resolve';
import { geometryFromDicom } from '../../lib/anchors/geometry';
import type { Finding } from '../../lib/types';
import type { CaptureChunk, ViewerSnapshot, JournalEntry } from '../../lib/journal/types';
async function main() {
  const [orgId, caseId, renderedJSON, mode = 'normal'] = process.argv.slice(2);
  if (!caseId?.startsWith('case-capture-') || !orgId || !process.env.DATA_DIR?.endsWith('.radlearn-tmp/radlearn-data')) throw new Error('Local synthetic fixture directory required');
  const rendered = JSON.parse(renderedJSON) as ViewerSnapshot;
  const study = JSON.parse(await readFile('fixtures/synthetic/study.json', 'utf8'));
  const singles = study.instances.filter((i: { seriesUID: string }) => i.seriesUID === study.seriesUIDs[0]);
  const first = { ...rendered, sopUID: singles[1].sopUID, frame: 1, renderSeq: 1, voi: { ww: 1500, wc: -600 }, camera: { ...rendered.camera, zoom: 1.2, pan: [6, -4] as [number, number] }, invert: true };
  const second = { ...first, sopUID: mode === 'missing' ? '1.2.826.0.1.3680043.10.543.100.1.999' : singles[2].sopUID, renderSeq: 2 };
  const geometry = geometryFromDicom(singles[1].metadata, 1);
  const journal: JournalEntry[] = [
    { seq: 0, t: 150, kind: 'render', snapshot: first, renderSeq: 1, payload: { displayIndex: 999 } },
    { seq: 1, t: 300, kind: 'marker', snapshot: first, renderSeq: 1, payload: { markerId: 'replay-point', imagePoint: { x: 20, y: 20 }, dimensions: [64, 64], geometry } },
    { seq: 2, t: 500, kind: 'annotation', snapshot: first, renderSeq: 1, payload: { annotationId: 'replay-length', imagePoints: [{ x: 10, y: 20 }, { x: 20, y: 20 }], dimensions: [64, 64], geometry, event: { tool: 'Length', label: 'Synthetic length' } } },
    { seq: 3, t: 1800, kind: 'render', snapshot: second, renderSeq: 2 },
    { seq: 4, t: 2800, kind: 'render', snapshot: { ...first, renderSeq: 3 }, renderSeq: 3 },
  ];
  if (mode === 'gap') journal.push({ seq: 5, t: 3000, kind: 'discontinuity', payload: { stream: 'audio', reason: 'media_delivery_gap' } });
  const captureId = 'replay-evidence', manifest = await startCapture(orgId, caseId, captureId), chunks: CaptureChunk[] = [];
  for (const [stream, bytes, mime] of [['journal', Buffer.from(JSON.stringify(journal)), 'application/json'], ['audio', await readFile('fixtures/synthetic/narration.wav'), 'audio/wav']] as const) {
    const chunk: CaptureChunk = { seq: chunks.length, stream, tStart: stream === 'audio' ? 350 : 0, tEnd: 4350, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime }; chunks.push(chunk); await putCaptureChunk(orgId, caseId, captureId, chunk, bytes);
  }
  await completeCapture(orgId, caseId, captureId, { ...manifest, chunks, durationMs: 4500, offsets: { audio: 350 } });
  await reviewCapture(orgId, caseId, captureId, { pixels: true, audio: true, screen: true });
  const base: Finding = { id: 'replay-one', order: 1, label: 'Synthetic replay focus', description: 'One retained CT focus', teachingPoints: ['Compare contours'], state: ' ', marker: { shape: 'circle', x_pct: .5, y_pct: .5 }, phiReview: { pixels: true, audio: true, screen: true } };
  const finding = { ...base, ...rebindPatch(base, { snapshot: first, imagePoint: { x: 20, y: 20 }, dimensions: [64, 64] }, singles.map((r: { metadata: unknown }) => r.metadata)), captureSessionId: captureId, resolvedAnchor: resolveAnchor('replay-point', journal), evidence: [{ tStart: 300, tEnd: 600, journalSeq: [0, 1, 2] }] };
  await createFinding(orgId, caseId, finding);
  const data = (await getCaseForOrg(orgId, caseId))!, f = data.findings.find(f => f.id === finding.id)!;
  const v = data.findingVersions!.find(v => v.findingId === f.id && v.version === f.currentVersion)!;
  await approve(orgId, caseId, f.id, v.version, v.contentHash, { id: 'synthetic-reviewer', membershipRole: 'author' });
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Fixture failed'); process.exitCode = 1; });
