/** Server only: callers supply the org-scoped stored Case, never a client projection. */
import type { Case, RecordedAnnotation } from "../types";
import { approvedFinding } from "../findingVersions";
import { inventoryFromMetadata, readFindingMetadata } from "../findingInventory";
import { emptyToolContext, type ApprovedToolContext, type ToolFrame } from "./approvedTools";
import { validSnapshot } from '../journal/viewer';
import type { ResolvedAnchor } from '../anchors/resolve';

const unit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(unit);
/** Only explicitly named image geometry is eligible; legacy guide indices cannot supply identity. */
export function namedAnnotation(raw: unknown, target: ToolFrame): RecordedAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  // M5+ annotations retain original image pixels, rather than legacy normalized handles.
  if (a.resolvedAnchor) {
    const r = a.resolvedAnchor as ResolvedAnchor, s = r.snapshot, dims = r.dimensions;
    const points = r.imagePoints ?? (r.imagePoint ? [r.imagePoint] : []);
    if (r.anchorStatus !== 'resolved' || !s || !validSnapshot(s) || ['studyUID', 'seriesUID', 'sopUID', 'frame'].some(k => s[k as keyof typeof s] !== target[k as keyof ToolFrame]) ||
        !dims || dims.length !== 2 || !dims.every(n => Number.isInteger(n) && n > 1) || !points.length) return null;
    const handles: [number, number][] = points.map(p => [p.x / (dims[0] - 1), p.y / (dims[1] - 1)]);
    if (!handles.every(pair) || !['Length', 'EllipticalROI', 'RectangleROI', 'Probe', 'ArrowAnnotate', 'Angle', 'Bidirectional'].includes(String(a.tool))) return null;
    return { shape: a.tool === 'ArrowAnnotate' ? 'arrow' : 'circle', from: handles[0], to: handles.at(-1)!, handles, tool: String(a.tool) };
  }
  if (["studyUID", "seriesUID", "sopUID", "frame"].some(k => a[k] !== target[k as keyof ToolFrame])) return null;
  if (!["circle", "arrow"].includes(String(a.shape)) || !pair(a.from) || !pair(a.to)) return null;
  if (a.handles !== undefined && (!Array.isArray(a.handles) || !a.handles.length || !a.handles.every(pair))) return null;
  if (a.tool !== undefined && !["Length", "EllipticalROI", "RectangleROI", "Probe", "ArrowAnnotate", "Angle"].includes(String(a.tool))) return null;
  return { shape: a.shape as RecordedAnnotation["shape"], from: a.from, to: a.to,
    ...(a.handles ? { handles: a.handles as [number, number][] } : {}), ...(a.tool ? { tool: a.tool as string } : {}) };
}

type MetadataRow = Record<string, { Value?: unknown[] }>;
export async function loadApprovedToolContext(
  data: Case,
  read = readFindingMetadata,
  current: () => Promise<Case | null> = async () => data,
): Promise<ApprovedToolContext> {
  const context = emptyToolContext();
  if (data.status !== "published") return context;
  const inventories = new Map<string, { inventory: ReturnType<typeof inventoryFromMetadata>; raw: MetadataRow[] } | null>();
  for (const f of data.findings) {
    if (!f.anchor || !f.currentVersion || f.currentVersion !== f.approvedVersion) continue;
    const key = JSON.stringify([f.anchor.studyUID, f.anchor.seriesUID]);
    if (!inventories.has(key)) {
      try { const raw = await read(f.anchor); inventories.set(key, { inventory: inventoryFromMetadata(f.anchor, raw), raw: raw as MetadataRow[] }); }
      catch { inventories.set(key, null); } // Unavailable/dirty metadata grants no tool authority.
    }
  }
  // Metadata I/O can be slow. Re-read the org-scoped case so an intervening edit or
  // revocation cannot authorize an old ID. New series wait for the next catalog load.
  const latest = await current();
  if (!latest || latest.caseId !== data.caseId || latest.orgId !== data.orgId || latest.status !== "published") return context;
  for (const f of latest.findings) {
    if (!f.anchor) continue;
    const key = JSON.stringify([f.anchor.studyUID, f.anchor.seriesUID]);
    const source = inventories.get(key);
    if (!source) continue;
    const approved = approvedFinding(latest, f, source.inventory);
    if (!approved?.anchor) continue;
    const { studyUID, seriesUID, sopUID, frame } = approved.anchor;
    const target = { studyUID, seriesUID, sopUID, frame };
    if (!context.series.some(s => s.studyUID === studyUID && s.seriesUID === seriesUID)) {
      const frames = source.inventory.instances.flatMap(i => Array.from({ length: i.frames }, (_, n) => ({ studyUID, seriesUID, sopUID: i.sopUID, frame: n + 1 })));
      context.series.push({ studyUID, seriesUID, frameCount: frames.length, frames });
    }
    const version = latest.findingVersions!.find(v => v.findingId === f.id && v.version === f.currentVersion)!;
    const id = `${encodeURIComponent(data.caseId)}/${encodeURIComponent(f.id)}/v${version.version}/${version.contentHash}/anchor`;
    const row = source.raw.find(row => row["00080018"]?.Value?.[0] === sopUID);
    const rows = Number(row?.["00280010"]?.Value?.[0]);
    const columns = Number(row?.["00280011"]?.Value?.[0]);
    let point: { x: number; y: number; space?: "image" | "viewport" } | undefined;
    if (approved.anchor.imagePoint) {
      const p = approved.anchor.imagePoint;
      if (Number.isInteger(rows) && rows > 1 && Number.isInteger(columns) && columns > 1 && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= columns - 1 && p.y >= 0 && p.y <= rows - 1) point = { x: p.x / (columns - 1), y: p.y / (rows - 1), space: "image" };
    } else if (unit(approved.marker?.x_pct) && unit(approved.marker?.y_pct)) point = { x: approved.marker.x_pct, y: approved.marker.y_pct };
    context.anchors.push({ id, findingId: f.id, target, ...(point ? { point } : {}) });
    for (const [i, raw] of (Array.isArray(approved.annotations) ? approved.annotations : []).entries()) {
      const annotation = namedAnnotation(raw, target);
      if (annotation) context.annotations.push({ id: `${id}/annotation/${i}`, anchorId: id, annotation });
    }
  }
  return context;
}
