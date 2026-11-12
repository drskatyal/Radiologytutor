import { randomUUID } from "node:crypto";
import { createVersion, mutateCase } from "../cases";
import { FindingConflict, hashContent } from "../findingContent";
import { generate, geminiConfigured, GEMINI_MODEL_DEFAULT, parseJsonLoose, type GenerateOptions, type GeminiPart, type GeminiResult } from "../gemini";
import { uploadGeminiFile } from "../geminiFiles";
import { captureMedia, captureSession } from "../journal/storage";
import { CaptureError } from "../journal/manifest";
import { assertNoPhi, assertReviewedMedia, PhiError } from "../phiGuard";
import { reconcileMarkers, type MarkerDecision } from "../anchors/reconcile";
import type { CaptureManifest } from "../journal/types";
import type { CaptureSession } from "../types";
import { EXTRACT_PROMPT_VERSION, extractionRequest } from "./prompt";
import { parseExtraction } from "./schema";
import { materializeExtraction } from "./materialize";
import type { ExtractionJob } from "./types";

export const EXTRACTOR_VERSION = "radlearn-extract-v1";
const LEASE_MS = 15 * 60 * 1000;
export function extractionIdentity(manifest: CaptureManifest, modelId = process.env.GEMINI_MODEL?.trim() || GEMINI_MODEL_DEFAULT, extractorVersion = EXTRACTOR_VERSION, promptVersion = EXTRACT_PROMPT_VERSION) {
  const manifestHash = hashContent(manifest);
  return { id: hashContent({ manifestHash, extractorVersion, promptVersion, modelId }), manifestHash, extractorVersion, promptVersion, modelId };
}
function requireComplete(session: CaptureSession) {
  if (session.manifest?.status !== "complete") throw new CaptureError("Complete capture sync before extraction", 409);
  assertReviewedMedia(session.manifest.phiReview);
}
export async function getExtraction(orgId: string, caseId: string, sessionId: string, jobId?: string): Promise<ExtractionJob | undefined> {
  const session = await captureSession(orgId, caseId, sessionId);
  requireComplete(session);
  return session.extractionJobs?.find(j => j.id === (jobId ?? extractionIdentity(session.manifest!).id));
}
// Dependency injection is a local test seam, never a request field or environment bypass.
export interface ExtractionDependencies {
  generate?: (options: GenerateOptions) => Promise<Pick<GeminiResult, "text" | "modelMetadata">>;
  upload?: typeof uploadGeminiFile;
  now?: () => number;
}
export async function runExtraction(orgId: string, caseId: string, sessionId: string, userId: string, options: { retry?: boolean; markerDecisions?: MarkerDecision[] } = {}, deps: ExtractionDependencies = {}): Promise<ExtractionJob> {
  const retained = await captureSession(orgId, caseId, sessionId);
  requireComplete(retained);
  if (options.markerDecisions !== undefined) {
    if (!Array.isArray(options.markerDecisions) || options.markerDecisions.length > 100 || options.markerDecisions.some(d => !d || Object.keys(d).some(k => !["kind", "markerIds", "reason"].includes(k)) || typeof d.reason !== "string" || d.reason.length > 1000)) throw new CaptureError("Invalid marker decisions");
    assertNoPhi(options.markerDecisions);
    try { reconcileMarkers(retained.journal ?? [], options.markerDecisions); } catch { throw new CaptureError("Invalid marker decisions"); }
  }
  const identity = extractionIdentity(retained.manifest!), now = deps.now ?? Date.now, leaseToken = randomUUID();
  let claimed = false, result!: ExtractionJob;
  await mutateCase(orgId, caseId, data => {
    claimed = false; // Mongo CAS may replay this callback.
    const session = data.captureSessions!.find(s => s.id === sessionId)!;
    requireComplete(session);
    if (hashContent(session.manifest) !== identity.manifestHash) throw new CaptureError("Capture changed; reload before extraction", 409);
    session.extractionJobs ??= [];
    let job = session.extractionJobs.find(j => j.id === identity.id);
    if (job && options.markerDecisions && hashContent(options.markerDecisions) !== hashContent(job.markerDecisions)) throw new CaptureError("Extraction already has a frozen marker plan; restore that plan before retrying", 409);
    if (job && (job.status !== "failed" && job.status !== "running" || !options.retry || job.status === "running" && (job.leaseExpiresAt ?? 0) > now())) { result = job; return data; }
    if (!job) {
      if (session.extractionJobs.length >= 32) throw new CaptureError("Capture extraction history limit reached", 409);
      if (options.markerDecisions) session.markerDecisions = structuredClone(options.markerDecisions);
      job = { ...identity, status: "running", createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), createdBy: userId, attempts: 0,
        markerDecisions: structuredClone(session.markerDecisions ?? []),
        baseFindings: data.findings.filter(f => f.captureSessionId === sessionId).map(f => ({ id: f.id, markerId: f.markerId, version: f.currentVersion! })),
        proposals: [], drafts: [], audit: [], receipts: [] };
      session.extractionJobs.push(job);
    }
    job.status = "running"; delete job.errorCode;
    job.attempts++; job.leaseToken = leaseToken; job.leaseExpiresAt = now() + LEASE_MS; job.updatedAt = new Date(now()).toISOString();
    result = job; claimed = true; return data;
  });
  if (!claimed) return result;
  const finish = async (patch: Partial<ExtractionJob>) => {
    await mutateCase(orgId, caseId, data => {
      const session = data.captureSessions!.find(s => s.id === sessionId)!;
      const current = session.extractionJobs!.find(j => j.id === identity.id)!;
      if (current.leaseToken === leaseToken && hashContent(session.manifest) === identity.manifestHash) {
        Object.assign(current, patch, { updatedAt: new Date(now()).toISOString() }); delete current.leaseToken; delete current.leaseExpiresAt;
      }
      result = current; return data;
    });
    return result;
  };
  if (!deps.generate && !geminiConfigured()) return finish({ status: "failed", errorCode: "MODEL_UNAVAILABLE" });
  try {
    const media: GeminiPart[] = [];
    let inlineBytes = 0;
    for (const stream of ["audio", "video"] as const) {
      if (!retained.manifest!.chunks.some(c => c.stream === stream)) continue;
      // Always read retained, reviewed bytes and verify every checksum; never client replacements.
      const content = await captureMedia(orgId, caseId, sessionId, stream, true);
      inlineBytes += content.bytes.length;
      if (inlineBytes <= 12 * 1024 * 1024) media.push({ inlineData: { mimeType: content.mimeType, data: content.bytes.toString("base64") } });
      else {
        const file = await (deps.upload ?? uploadGeminiFile)({ bytes: content.bytes, mimeType: content.mimeType, displayName: "reviewed-capture" });
        media.push({ fileData: { fileUri: file.uri, mimeType: file.mimeType } });
      }
    }
    if (!media.length) throw new CaptureError("Reviewed audio or video is required", 422);
    const response = await (deps.generate ?? generate)(extractionRequest({ manifest: retained.manifest!, journal: retained.journal ?? [], media, modelId: identity.modelId }));
    if (response.modelMetadata.requestedModel !== identity.modelId || response.text.length > 1024 * 1024) throw new Error("Invalid extraction response");
    const parsed = parseExtraction(parseJsonLoose(response.text));
    const drafts = materializeExtraction(retained, result, parsed.proposals, response.modelMetadata, result.markerDecisions);
    for (const draft of drafts) draft.finding.provenance!.promptVersion = identity.promptVersion;
    return await finish({ status: "ready", proposals: parsed.proposals, audit: parsed.audit, drafts, modelMetadata: response.modelMetadata });
  } catch (error) {
    // Never persist/log provider bodies, raw model output or PHI-bearing exception text.
    return finish({ status: "failed", errorCode: error instanceof PhiError ? "PHI_REVIEW_REQUIRED" : "EXTRACTION_FAILED" });
  }
}

export async function commitExtraction(orgId: string, caseId: string, sessionId: string, jobId: string, userId: string): Promise<ExtractionJob> {
  const session = await captureSession(orgId, caseId, sessionId);
  requireComplete(session);
  const job = session.extractionJobs?.find(j => j.id === jobId);
  if (!job) throw new CaptureError("Extraction job not found", 404);
  if (job.status === "committed") return job;
  if (job.status !== "ready" && job.status !== "conflict") throw new CaptureError("Extraction is not ready to commit", 409);
  if (hashContent(session.manifest) !== job.manifestHash || hashContent(session.markerDecisions ?? []) !== hashContent(job.markerDecisions)) throw new CaptureError("Capture or marker decisions changed; review before committing", 409);
  let result = job;
  const update = async (status: ExtractionJob["status"], receipt?: ExtractionJob["receipts"][number]) => {
    await mutateCase(orgId, caseId, data => {
      const current = data.captureSessions!.find(s => s.id === sessionId)!.extractionJobs!.find(j => j.id === jobId)!;
      if (receipt && !current.receipts.some(r => r.draftId === receipt.draftId)) current.receipts.push(receipt);
      // Concurrent retries cannot downgrade a completed job.
      if (current.status !== "committed") current.status = status;
      if (current.status === "conflict") current.errorCode = "VERSION_CONFLICT"; else delete current.errorCode;
      current.updatedAt = new Date().toISOString(); result = current; return data;
    });
  };
  try {
    for (const draft of job.drafts) {
      const data = await createVersion(orgId, caseId, draft.finding.id, draft.finding, { expectedVersion: draft.expectedVersion, userId, sourceKey: draft.sourceKey });
      const version = data.findingVersions!.find(v => v.findingId === draft.finding.id && v.sourceKey === draft.sourceKey)!;
      await update("ready", { draftId: draft.id, findingId: version.findingId, version: version.version, contentHash: version.contentHash });
    }
    await update("committed");
  } catch (error) {
    if (!(error instanceof FindingConflict)) throw error;
    await update("conflict");
  }
  return result;
}
