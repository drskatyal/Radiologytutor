// Local-only model seam: real persisted job code, synthetic reviewed browser media.
// No production route, env bypass, API key, HTTP provider or GCP call is used.
import { captureSession } from "../../lib/journal/storage";
import { retainedMarkers } from "../../lib/anchors/resolve";
import { runExtraction } from "../../lib/extract/run";
import { buildGenerateRequest } from "../../lib/gemini";
import { hashContent } from "../../lib/findingContent";
async function main() {
  const [orgId, caseId, sessionId] = process.argv.slice(2);
  if (!orgId || !caseId || !sessionId || !process.env.DATA_DIR?.endsWith(".radlearn-tmp/radlearn-data")) throw new Error("Local fixture directory required");
  const session = await captureSession(orgId, caseId, sessionId);
  const markers = retainedMarkers(session.journal!);
  const job = await runExtraction(orgId, caseId, sessionId, "synthetic-model-fixture", {}, { generate: async options => ({
    text: JSON.stringify({ findings: markers.map((m, i) => ({ label: `Synthetic extracted focus ${i + 1}`, description: "Synthetic contour observation", teachingPoints: ["Compare adjacent images"], dictatedOrVisual: "both", confidence: .95,
      markerId: m.payload!.markerId, evidence: [{ tStart: m.t, tEnd: Math.min(m.t + 20, markers[i + 1]?.t ?? session.durationMs, session.durationMs), journalSeq: [m.seq] }] })) }),
    modelMetadata: { requestedModel: options.model!, responseModelVersion: "local-synthetic-mock", apiSurface: "generateContent", configHash: hashContent({ model: options.model, body: buildGenerateRequest(options, options.model!) }) },
  }) });
  if (job.status !== "ready" || job.drafts.length !== 2 || job.drafts.some(d => d.issues.length)) throw new Error(`Synthetic extraction did not resolve: ${JSON.stringify({ status: job.status, error: job.errorCode, issues: job.drafts.map(d => d.issues) })}`);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Fixture failed"); process.exitCode = 1; });
