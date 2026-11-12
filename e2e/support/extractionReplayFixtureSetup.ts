// Single-finding M8 model seam. Actual journal/media/job/approval/replay remain real and local.
import { captureSession } from '../../lib/journal/storage';
import { retainedMarkers } from '../../lib/anchors/resolve';
import { runExtraction } from '../../lib/extract/run';
import { buildGenerateRequest } from '../../lib/gemini';
import { hashContent } from '../../lib/findingContent';
async function main() {
  const [orgId, caseId, sessionId] = process.argv.slice(2);
  if (!caseId?.startsWith('case-capture-') || !orgId || !sessionId || !process.env.DATA_DIR?.endsWith('.radlearn-tmp/radlearn-data')) throw new Error('Local synthetic fixture directory required');
  const session = await captureSession(orgId, caseId, sessionId), markers = retainedMarkers(session.journal!);
  if (markers.length !== 1) throw new Error('Exactly one real retained marker required');
  const m = markers[0];
  const job = await runExtraction(orgId, caseId, sessionId, 'synthetic-roundtrip', {}, { generate: async options => ({
    text: JSON.stringify({ findings: [{ label: 'Synthetic single focus', description: 'Synthetic contour', teachingPoints: ['Compare contours'], dictatedOrVisual: 'both', confidence: .95, markerId: m.payload!.markerId, evidence: [{ tStart: m.t, tEnd: Math.min(m.t + 20, session.durationMs), journalSeq: [m.seq] }] }] }),
    modelMetadata: { requestedModel: options.model!, responseModelVersion: 'local-synthetic-mock', apiSurface: 'generateContent', configHash: hashContent({ model: options.model, body: buildGenerateRequest(options, options.model!) }) },
  }) });
  if (job.status !== 'ready' || job.drafts.length !== 1 || job.drafts.some(d => d.issues.length)) throw new Error(`One resolved draft required: ${JSON.stringify({ status: job.status, error: job.errorCode, issues: job.drafts.map(d => d.issues) })}`);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Fixture failed'); process.exitCode = 1; });
