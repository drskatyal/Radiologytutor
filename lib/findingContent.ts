import { createHash } from "node:crypto";
import type { Finding, FindingAnchorSnapshot, FindingContent } from "./types";
export class FindingConflict extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export const hashContent = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Explicit immutable content allowlist. Never copy client approval/version bookkeeping. */
export function findingContent(f: Finding): FindingContent {
  const keys = FINDING_CONTENT_KEYS;
  return structuredClone(Object.fromEntries(keys.filter(key => f[key] !== undefined).map(key => [key, f[key]]))) as FindingContent;
}
export const FINDING_CONTENT_KEYS = ["expertReview", "extraction", "resolvedAnchor", "groupedAnchors", "markerReconciliation", "label", "description", "teachingPoints", "state", "marker", "keyframes", "track", "teachingGuide", "durationMs", "studyInstanceUID", "seriesInstanceUID", "sopInstanceUID", "sopInstanceUIDs", "frameNumber", "imagePoint", "landmark", "windowWidth", "windowCenter", "measurements", "anchors", "annotations", "anchor", "evidence", "provenance", "phiReview", "reportGold", "reportMustMention", "captureSessionId", "markerId", "segmentId", "tStartMs", "tEndMs"] as const;
export function anchorFromFinding(f: Finding): FindingAnchorSnapshot | undefined {
  if (f.extraction?.issues.length) return undefined;
  if ((f.resolvedAnchor && f.resolvedAnchor.anchorStatus !== "resolved") || f.groupedAnchors?.some(a => a.anchorStatus !== "resolved")) return undefined;
  return f.anchor ?? (f.studyInstanceUID && f.seriesInstanceUID && f.sopInstanceUID && f.frameNumber ? {
    studyUID: f.studyInstanceUID, seriesUID: f.seriesInstanceUID, sopUID: f.sopInstanceUID, frame: f.frameNumber,
    imagePoint: f.imagePoint, view: { ww: f.windowWidth, wc: f.windowCenter },
  } : undefined);
}
