import type { Finding } from "../types";
import type { GeminiRequestMetadata } from "../geminiMetadata";
import type { DiscardAudit, ExtractProposal } from "./schema";
export interface ExtractDraft {
  id: string; proposalIndexes: number[]; issues: string[];
  finding: Finding; expectedVersion: number; sourceKey: string;
}
export interface ExtractionJob {
  id: string; manifestHash: string; extractorVersion: string; promptVersion: string; modelId: string;
  status: "running" | "ready" | "failed" | "committed" | "conflict";
  createdAt: string; updatedAt: string; createdBy: string; attempts: number;
  leaseToken?: string; leaseExpiresAt?: number;
  markerDecisions: import("../anchors/reconcile").MarkerDecision[];
  baseFindings: Array<{ id: string; markerId?: string; version: number }>;
  proposals: ExtractProposal[]; drafts: ExtractDraft[]; audit: DiscardAudit[];
  modelMetadata?: GeminiRequestMetadata;
  errorCode?: "MODEL_UNAVAILABLE" | "EXTRACTION_FAILED" | "PHI_REVIEW_REQUIRED" | "VERSION_CONFLICT";
  receipts: Array<{ draftId: string; findingId: string; version: number; contentHash: string }>;
}
