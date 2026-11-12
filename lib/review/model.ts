import type { Case, Finding, FindingVersion } from "../types";
import type { ViewerSnapshot } from "../journal/types";
import { validSnapshot } from "../journal/viewer";
export interface FindingReviewState {
  finding: Finding; versions: FindingVersion[]; version: number; contentHash: string;
  approved: boolean; canApprove: boolean; reasons: string[];
  anchorStatus: "resolved" | "unresolved" | "legacy_index";
  snapshot: ViewerSnapshot | null;
}
export interface CaseReview { caseData: Case; findings: FindingReviewState[] }
/** A legacy index or the current viewport cannot fill in a missing recorded view. */
export function reviewSnapshot(f: Finding): ViewerSnapshot | null {
  const a = f.anchor;
  const identity = { studyUID: f.studyInstanceUID ?? a?.studyUID, seriesUID: f.seriesInstanceUID ?? a?.seriesUID, sopUID: f.sopInstanceUID ?? a?.sopUID, frame: f.frameNumber ?? a?.frame };
  if (!identity.studyUID || !identity.seriesUID || !identity.sopUID || !identity.frame) return null;
  const s = f.resolvedAnchor?.snapshot;
  if (!s || !validSnapshot(s) || s.studyUID !== identity.studyUID || s.seriesUID !== identity.seriesUID || s.sopUID !== identity.sopUID || s.frame !== identity.frame) return null;
  return structuredClone(s);
}
const stable = (value: unknown): string => value && typeof value === "object" ? Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value) ?? "—";
export function versionDiff(before: FindingVersion | undefined, after: FindingVersion): Array<{ field: string; before: string; after: string }> {
  const a = before?.content ?? {}, b = after.content;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(field => {
    const left = stable(a[field as keyof typeof a]), right = stable(b[field as keyof typeof b]);
    return left === right ? [] : [{ field, before: left, after: right }];
  });
}
export function evidenceMediaTime(t: number, offset: number, durationMs: number): number | null {
  return Number.isFinite(t) && Number.isFinite(offset) && t >= offset && t <= durationMs ? (t - offset) / 1000 : null;
}

/** Legacy annotation blobs do not inherit a neighbouring finding's calibration. */
export function annotationSummary(value: unknown): { label: string; calibration: string; frame: number | null } {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const anchor = row.resolvedAnchor as Finding["resolvedAnchor"] | undefined;
  const calibrated = !!anchor && anchor.anchorStatus === "resolved" && !!anchor.snapshot && validSnapshot(anchor.snapshot);
  return { label: typeof row.label === "string" ? row.label : "", calibration: calibrated && ["PixelSpacing", "ImagerPixelSpacing"].includes(anchor.calibration) ? anchor.calibration : "uncalibrated", frame: calibrated ? anchor.snapshot!.frame : null };
}
