import { getCaseForOrg, mutateCase, createVersion } from "../cases";
import { FindingConflict, findingContent, hashContent } from "../findingContent";
import { readFindingMetadata, inventoryFromMetadata, instanceSetFingerprint, resolveFindingAnchor } from "../findingInventory";
import { assertNoPhi, assertReviewedMedia } from "../phiGuard";
import { geometryFromDicom, pixelToPatient } from "../anchors/geometry";
import { validSnapshot, type ImagePointEvidence } from "../journal/viewer";
import { reviewSnapshot, type CaseReview, type FindingReviewState } from "./model";
import type { Case, Finding, FindingAnchorSnapshot, SeriesInventory } from "../types";
const identity = (f: Finding): FindingAnchorSnapshot | undefined => f.anchor ?? (f.studyInstanceUID && f.seriesInstanceUID && f.sopInstanceUID && f.frameNumber ? { studyUID: f.studyInstanceUID, seriesUID: f.seriesInstanceUID, sopUID: f.sopInstanceUID, frame: f.frameNumber, view: {} } : undefined);
const keyOf = (a: FindingAnchorSnapshot) => `${a.studyUID}/${a.seriesUID}`;
export function findingReview(data: Case, f: Finding, inventory?: SeriesInventory): FindingReviewState {
  const versions = (data.findingVersions ?? []).filter(v => v.findingId === f.id).sort((a, b) => a.version - b.version);
  const version = versions.find(v => v.version === f.currentVersion), reasons: string[] = [];
  const current = !!version && version.contentHash === hashContent(version.content) && version.contentHash === hashContent(findingContent(f));
  if (!current) reasons.push("This version changed. Reload before approving.");
  const anchorStatus = resolveFindingAnchor(identity(f), inventory);
  if (anchorStatus === "legacy_index") reasons.push("Incomplete image identity: rebind the anchor.");
  else if (!inventory) reasons.push("Image inventory unavailable. Retry verification.");
  else if (anchorStatus !== "resolved") reasons.push("Image not found: rebind");
  if (inventory && version && (version.content.provenance?.instanceSetFingerprint !== instanceSetFingerprint(inventory) || version.content.provenance.orderingAlgorithmVersion !== inventory.orderingAlgorithmVersion)) reasons.push("Image evidence changed. Save a new version before approving.");
  if (f.extraction?.issues.length) reasons.push("Review the uncertain extraction evidence before approving.");
  if (f.resolvedAnchor?.anchorStatus === "unresolved" || f.groupedAnchors?.some(a => a.anchorStatus !== "resolved")) reasons.push("Unresolved anchor: rebind the displayed image.");
  try { assertNoPhi(findingContent(f)); } catch { reasons.push("Remove patient identifiers from the finding."); }
  try { assertReviewedMedia(f.phiReview); } catch { reasons.push("Confirm the images, audio and screen contain no patient identifiers."); }
  const approved = current && !reasons.length && f.approvedVersion === f.currentVersion && !!data.findingApprovals?.some(a => a.findingId === f.id && a.version === f.currentVersion && a.contentHash === version?.contentHash && !a.revokedAt);
  const snapshot = reviewSnapshot(f);
  if (!snapshot && !approved) reasons.push("Full view was not recorded: rebind before approval.");
  return { finding: f, versions, version: f.currentVersion ?? 0, contentHash: version?.contentHash ?? "", approved, canApprove: !approved && !reasons.length, reasons, anchorStatus, snapshot };
}
export async function loadCaseReview(orgId: string, caseId: string): Promise<CaseReview> {
  const data = await getCaseForOrg(orgId, caseId);
  if (!data) throw new FindingConflict("Case not found", 404);
  const inventories = new Map<string, SeriesInventory | undefined>();
  const anchors = new Map(data.findings.flatMap(f => { const a = identity(f); return a ? [[keyOf(a), a] as const] : []; }));
  await Promise.all([...anchors].map(async ([key, a]) => { try { inventories.set(key, inventoryFromMetadata(a, await readFindingMetadata(a))); } catch { inventories.set(key, undefined); } }));
  let result!: CaseReview;
  await mutateCase(orgId, caseId, latest => {
    const findings = latest.findings.map(f => {
      const a = identity(f), inventory = a ? inventories.get(keyOf(a)) : undefined;
      const review = findingReview(latest, f, inventory);
      if (review.approved && inventory) {
        const inventoryOrderHash = hashContent(inventory.instances.map(i => i.sopUID));
        const prior = latest.findingRevalidations?.filter(r => r.findingId === f.id && r.version === f.currentVersion).at(-1);
        if (prior?.inventoryOrderHash !== inventoryOrderHash) {
          latest.findingRevalidations ??= [];
          latest.findingRevalidations.push({ findingId: f.id, version: review.version, contentHash: review.contentHash, inventoryOrderHash, checkedAt: new Date().toISOString(), reason: "order_revalidated" });
        }
      }
      return review;
    });
    result = { caseData: latest, findings }; return latest;
  });
  return result;
}
export interface ReviewEdit {
  expectedVersion: number; contentHash: string;
  text?: { label: string; description: string; teachingPoints: string[] };
  phiReview?: { pixels: boolean; audio: boolean; screen: boolean };
  rebind?: ImagePointEvidence;
  resolveExtraction?: { reason: string };
}
/** Author-selected geometry is validated against fresh image metadata, never accepted from a model. */
export function rebindPatch(f: Finding, evidence: ImagePointEvidence, raw: unknown): Partial<Finding> {
  const s = evidence?.snapshot, p = evidence?.imagePoint;
  if (!s || !validSnapshot(s) || /mpr|volume/i.test(s.layout)) throw new FindingConflict("A complete rendered stack image is required", 422);
  const a = { studyUID: s.studyUID, seriesUID: s.seriesUID, sopUID: s.sopUID, frame: s.frame, view: {} };
  const inventory = inventoryFromMetadata(a, raw);
  if (resolveFindingAnchor(a, inventory) !== "resolved") throw new FindingConflict("Image not found: rebind", 422);
  const row = (raw as Array<Record<string, { Value?: unknown[] }>>).find(r => r["00080018"]?.Value?.[0] === s.sopUID)!;
  const dimensions: [number, number] = [Number(row["00280011"]?.Value?.[0]), Number(row["00280010"]?.Value?.[0])];
  if (!dimensions.every(n => Number.isInteger(n) && n > 1) || !p || ![p.x, p.y].every(Number.isFinite) || p.x < 0 || p.y < 0 || p.x > dimensions[0] - 1 || p.y > dimensions[1] - 1) throw new FindingConflict("Choose a point inside the rendered image", 422);
  const geometry = geometryFromDicom(row, s.frame);
  const resolvedAnchor = { anchorId: `review-${f.id}`, anchorStatus: "resolved" as const, snapshot: structuredClone(s), imagePoint: { ...p }, dimensions, geometry, calibration: geometry.calibration, patientPoint: pixelToPatient(p, geometry), journalSeq: [] };
  return { studyInstanceUID: s.studyUID, seriesInstanceUID: s.seriesUID, sopInstanceUID: s.sopUID, frameNumber: s.frame,
    anchor: { ...a, imagePoint: p, view: { ww: s.voi.ww, wc: s.voi.wc, ...s.camera, invert: s.invert } }, resolvedAnchor, imagePoint: p,
    marker: { shape: "circle", x_pct: p.x / (dimensions[0] - 1), y_pct: p.y / (dimensions[1] - 1) }, windowWidth: s.voi.ww, windowCenter: s.voi.wc,
    sopInstanceUIDs: [s.sopUID], markerReconciliation: undefined, groupedAnchors: [], anchors: [], annotations: [], measurements: [], track: undefined, teachingGuide: undefined, keyframes: [], state: " ",
  };
}
export async function saveReview(orgId: string, caseId: string, findingId: string, userId: string, input: ReviewEdit): Promise<Case> {
  if (!input || Object.keys(input).some(k => !["expectedVersion", "contentHash", "text", "phiReview", "rebind", "resolveExtraction"].includes(k)) || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || typeof input.contentHash !== "string") throw new FindingConflict("Version and content hash are required", 400);
  const data = await getCaseForOrg(orgId, caseId), f = data?.findings.find(f => f.id === findingId);
  if (!data || !f) throw new FindingConflict("Finding not found", 404);
  const v = data.findingVersions?.find(v => v.findingId === f.id && v.version === input.expectedVersion);
  if (f.currentVersion !== input.expectedVersion || !v || v.contentHash !== input.contentHash || hashContent(v.content) !== input.contentHash || hashContent(findingContent(f)) !== input.contentHash) throw new FindingConflict("Finding changed. Reload before saving; your text is kept.");
  const patch: Partial<Finding> = {};
  if (input.text) {
    const { label, description, teachingPoints } = input.text;
    if (typeof label !== "string" || !label.trim() || label.length > 200 || typeof description !== "string" || description.length > 6000 || !Array.isArray(teachingPoints) || teachingPoints.length > 20 || teachingPoints.some(p => typeof p !== "string" || p.length > 1000)) throw new FindingConflict("Check the label, description and teaching points", 422);
    Object.assign(patch, { label: label.trim(), description: description.trim(), teachingPoints: teachingPoints.map(p => p.trim()).filter(Boolean) });
  }
  if (input.phiReview) {
    if (["pixels", "audio", "screen"].some(k => typeof input.phiReview![k as keyof typeof input.phiReview] !== "boolean")) throw new FindingConflict("Complete all media review fields", 422);
    patch.phiReview = { pixels: input.phiReview.pixels, audio: input.phiReview.audio, screen: input.phiReview.screen };
  }
  if (input.rebind) {
    const s = input.rebind.snapshot;
    if (!s || !validSnapshot(s)) throw new FindingConflict("A complete rendered image is required", 422);
    if (!data.studyRefs?.some(ref => ref.studyInstanceUID === s.studyUID && ref.seriesInstanceUIDs?.includes(s.seriesUID))) throw new FindingConflict("Choose an image from this case", 422);
    const raw = await readFindingMetadata({ studyUID: s.studyUID, seriesUID: s.seriesUID, sopUID: s.sopUID, frame: s.frame, view: {} });
    Object.assign(patch, rebindPatch(f, input.rebind, raw));
  }
  if (input.resolveExtraction) {
    const reason = input.resolveExtraction.reason;
    if (!input.rebind || typeof reason !== "string" || reason.trim().length < 8 || reason.length > 1000) throw new FindingConflict("Rebind and explain how you resolved the uncertain evidence", 422);
    if (f.extraction) patch.extraction = { ...f.extraction, issues: [] };
  }
  patch.expertReview = { sourceVersion: v.version, sourceHash: v.contentHash, userId, at: new Date().toISOString(), kind: input.rebind ? "rebind" : "edit", resolvedIssues: input.resolveExtraction ? f.extraction?.issues ?? [] : [], reason: input.resolveExtraction?.reason.trim() ?? "" };
  assertNoPhi(patch);
  return createVersion(orgId, caseId, findingId, patch, { expectedVersion: input.expectedVersion, userId });
}
