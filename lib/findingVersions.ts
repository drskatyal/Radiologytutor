import type { Case, Finding, FindingVersion, SeriesInventory } from "./types";
import { anchorFromFinding, FindingConflict, findingContent, hashContent } from "./findingContent";
import { instanceSetFingerprint, resolveFindingAnchor } from "./findingInventory";
import { assertNoPhi, assertReviewedMedia } from "./phiGuard";
import { canAccessOrgResource } from "./authRoles";
import type { MembershipRole, PlatformRole } from "./types";
export { FindingConflict } from "./findingContent";

export function snapshot(finding: Finding, version: number, userId: string, at: string): FindingVersion {
  const content = findingContent(finding);
  return { findingId: finding.id, version, contentHash: hashContent(content), content,
    anchor: anchorFromFinding(finding), evidence: finding.evidence ?? [], createdBy: userId, createdAt: at,
    parentVersion: version > 1 ? version - 1 : null };
}
/** Pure migration: no approvals, no inferred image identities, no remote writes. */
export function migrateFindings(data: Case): Case {
  const next = structuredClone(data);
  next.findingVersions ??= [];
  next.findingApprovals ??= [];
  for (const f of next.findings) {
    if (next.findingVersions.some(v => v.findingId === f.id)) continue;
    f.currentVersion = 1;
    f.status = "needs_review";
    delete f.approvedVersion;
    f.anchor = anchorFromFinding(f);
    f.anchorStatus = resolveFindingAnchor(f.anchor);
    next.findingVersions.push(snapshot(f, 1, "legacy-migration", data.updatedAt));
  }
  return next;
}
export function prepareFinding(current: Finding, patch: Partial<Finding>, inventory?: SeriesInventory): Finding {
  const next = { ...current, ...findingContent(patch as Finding), id: current.id };
  // An explicit identity edit must not retain the previous canonical anchor.
  if (!("anchor" in patch) && ["studyInstanceUID", "seriesInstanceUID", "sopInstanceUID", "frameNumber", "imagePoint", "windowWidth", "windowCenter"].some(k => k in patch)) delete next.anchor;
  next.anchor = anchorFromFinding(next);
  next.anchorStatus = resolveFindingAnchor(next.anchor, inventory);
  if (inventory) next.provenance = {
    instanceSetFingerprint: instanceSetFingerprint(inventory), orderingAlgorithmVersion: inventory.orderingAlgorithmVersion,
    modelId: next.provenance?.modelId ?? "manual", promptVersion: next.provenance?.promptVersion ?? "manual-v1",
  };
  return next;
}
export function appendVersion(data: Case, findingId: string, prepared: Finding, expectedVersion: number, userId: string): Case {
  const next = migrateFindings(data);
  const index = next.findings.findIndex(f => f.id === findingId);
  const current = next.findings[index];
  if (!current) throw new FindingConflict("Finding not found", 404);
  if (current.currentVersion !== expectedVersion) throw new FindingConflict("Finding changed; reload before saving");
  const f = { ...prepared, id: findingId, order: current.order, sliceIndex: current.sliceIndex,
    currentVersion: expectedVersion + 1, status: "needs_review" as const, approvedVersion: undefined };
  const at = new Date().toISOString();
  next.findings[index] = f;
  next.findingVersions!.push(snapshot(f, f.currentVersion, userId, at));
  next.updatedAt = at;
  return next;
}
export interface Approver { id: string; membershipRole?: MembershipRole | null; platformRole?: PlatformRole | null }
export function approveVersion(data: Case, findingId: string, version: number, contentHash: string, user: Approver, inventory?: SeriesInventory): Case {
  if (!canAccessOrgResource({ ...user, need: "author" })) throw new FindingConflict("Author access required", 403);
  const next = migrateFindings(data);
  const f = next.findings.find(row => row.id === findingId);
  const v = next.findingVersions!.find(row => row.findingId === findingId && row.version === version);
  if (!f || !v) throw new FindingConflict("Finding version not found", 404);
  if (f.currentVersion !== version || v.contentHash !== contentHash || hashContent(findingContent(f)) !== contentHash) throw new FindingConflict("Finding changed; reload before approving");
  if (resolveFindingAnchor(v.anchor, inventory) !== "resolved") throw new FindingConflict("Complete, resolved Study/Series/SOP/frame identity required", 422);
  if (!inventory || v.content.provenance?.instanceSetFingerprint !== instanceSetFingerprint(inventory) || v.content.provenance.orderingAlgorithmVersion !== inventory.orderingAlgorithmVersion) throw new FindingConflict("Image inventory changed; create a new reviewed version");
  assertNoPhi(v.content);
  assertReviewedMedia(v.content.phiReview);
  const at = new Date().toISOString();
  if (!next.findingApprovals!.some(a => a.findingId === findingId && a.version === version && a.contentHash === contentHash && !a.revokedAt)) next.findingApprovals!.push({ findingId, version, contentHash, approvedBy: user.id, approvedAt: at });
  f.status = "approved"; f.approvedVersion = version; f.anchorStatus = "resolved";
  next.updatedAt = at;
  return next;
}
export function approvedFinding(data: Case, f: Finding, inventory?: SeriesInventory): Finding | null {
  if (data.status !== "published" || f.currentVersion !== f.approvedVersion || !f.currentVersion) return null;
  const v = data.findingVersions?.find(v => v.findingId === f.id && v.version === f.currentVersion);
  const approval = data.findingApprovals?.find(a => a.findingId === f.id && a.version === f.currentVersion && a.contentHash === v?.contentHash && !a.revokedAt);
  if (!v || !approval || v.contentHash !== hashContent(findingContent(f)) || v.contentHash !== hashContent(v.content)) return null;
  if (!inventory || resolveFindingAnchor(v.anchor, inventory) !== "resolved" || v.content.provenance?.instanceSetFingerprint !== instanceSetFingerprint(inventory) || v.content.provenance.orderingAlgorithmVersion !== inventory.orderingAlgorithmVersion) return null;
  try { assertNoPhi(v.content); assertReviewedMedia(v.content.phiReview); } catch { return null; }
  return { ...f, ...structuredClone(v.content), anchorStatus: "resolved", status: "approved" };
}
