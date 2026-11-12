import type { JournalEntry, ViewerSnapshot } from "../journal/types";
import { validSnapshot } from "../journal/viewer";
import { matchesView } from "../journal/match";
import { pixelToPatient, uncalibratedGeometry, validGeometry, type ImageGeometry, type ImagePoint, type Vec3, type Calibration } from "./geometry";

export interface ResolvedAnchor {
  anchorId: string;
  anchorStatus: "resolved" | "unresolved" | "legacy_index";
  snapshot: ViewerSnapshot | null;
  imagePoint: ImagePoint | null;
  dimensions: [number, number] | null;
  patientPoint: Vec3 | null;
  calibration: Calibration;
  geometry: ImageGeometry;
  journalSeq: number[];
  imagePoints?: ImagePoint[];
  patientPoints?: Array<Vec3 | null>;
}
/** Append-only marker history: moves replace geometry, remove/undo removes identity. */
export function retainedMarkers(journal: readonly JournalEntry[]): JournalEntry[] {
  const retained = new Map<string, JournalEntry>();
  for (const e of journal) {
    if (e.kind !== "marker" || typeof e.payload?.markerId !== "string") continue;
    const id = e.payload.markerId;
    if (e.payload.action === "remove" || e.payload.action === "undo") retained.delete(id);
    else if (!e.payload.action || e.payload.action === "add" || e.payload.action === "move") retained.set(id, e);
  }
  return [...retained.values()];
}
const pointValid = (p: ImagePoint | null, dims: [number, number] | null) => !!p && !!dims && Array.isArray(dims) && dims.length === 2 && dims.every(n => Number.isInteger(n) && n > 1) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= dims[0] - 1 && p.y <= dims[1] - 1;
/** The same pure resolver serves preview and every materialization path. */
export function resolveAnchor(id: string | undefined, journal: readonly JournalEntry[]): ResolvedAnchor {
  const fallback: ResolvedAnchor = { anchorId: id ?? "", anchorStatus: "unresolved", snapshot: null, imagePoint: null, dimensions: null, patientPoint: null, calibration: "uncalibrated", geometry: uncalibratedGeometry(), journalSeq: [] };
  if (typeof id !== "string" || !id) return fallback;
  const marker = retainedMarkers(journal).find(e => e.payload?.markerId === id);
  const annotation = [...journal].reverse().find(e => e.kind === "annotation" && e.payload?.annotationId === id);
  const e = marker ?? annotation;
  if (!e || e.payload?.action === "remove") return fallback;
  if (!e.snapshot || !validSnapshot(e.snapshot)) return { ...fallback, anchorStatus: "legacy_index" };
  const p = e.payload ?? {};
  const points = Array.isArray(p.imagePoints) ? p.imagePoints as ImagePoint[] : undefined;
  const imagePoint = p.imagePoint as ImagePoint | undefined ?? points?.[0] ?? null;
  const dimensions = p.dimensions as [number, number] | undefined ?? null;
  const geometry = validGeometry(p.geometry as ImageGeometry) ? structuredClone(p.geometry as ImageGeometry) : uncalibratedGeometry();
  const render = [...journal].reverse().find(r => r.seq <= e.seq && r.t <= e.t && r.kind === "render" && r.snapshot?.renderSeq === e.snapshot!.renderSeq && matchesView(r.snapshot!, e.snapshot!));
  const resolved = !!render && pointValid(imagePoint, dimensions) && (p.imagePoints === undefined || (!!points?.length && points.every(p => pointValid(p, dimensions)))) && !/mpr|volume/i.test(e.snapshot.layout);
  return { anchorId: id, anchorStatus: resolved ? "resolved" : "unresolved", snapshot: structuredClone(e.snapshot), imagePoint: imagePoint ? structuredClone(imagePoint) : null,
    dimensions, geometry, calibration: geometry.calibration, patientPoint: imagePoint ? pixelToPatient(imagePoint, geometry) : null,
    journalSeq: render ? [render.seq, e.seq] : [e.seq],
    ...(points ? { imagePoints: structuredClone(points), patientPoints: points.map(p => pixelToPatient(p, geometry)) } : {}),
  };
}
