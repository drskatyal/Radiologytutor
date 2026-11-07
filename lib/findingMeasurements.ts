/**
 * Normalize Cornerstone annotation tools into durable FindingMeasurement rows.
 * Tools draw in world space; we persist overlay [0,1] handles + numeric stats
 * (mm / HU) so tutors and student UI can teach without re-querying voxels.
 */

import type {
  FindingMeasurement,
  FindingMeasurementKind,
  RecordedAnnotation,
  RecordedEvent,
  RecordedTrack,
} from "./types";

export type RawAnnotationLike = {
  annotationUID?: string;
  metadata?: { toolName?: string };
  data?: {
    handles?: { points?: number[][] };
    cachedStats?: Record<
      string,
      {
        mean?: number;
        max?: number;
        min?: number;
        stdDev?: number;
        area?: number;
        areaUnit?: string;
        length?: number;
        unit?: string;
        modalityUnit?: string;
        Modality?: string;
      }
    >;
    label?: string;
  };
};

const TOOL_KIND: Record<string, FindingMeasurementKind> = {
  Length: "length",
  EllipticalROI: "ellipse",
  RectangleROI: "ellipse",
  Probe: "probe",
  Bidirectional: "bidirectional",
  ArrowAnnotate: "arrow",
  Angle: "angle",
};

function firstStats(
  cached?: RawAnnotationLike["data"]
): NonNullable<RawAnnotationLike["data"]>["cachedStats"] extends infer S
  ? S extends Record<string, infer V>
    ? V | undefined
    : undefined
  : undefined {
  const stats = cached?.cachedStats;
  if (!stats) return undefined;
  const vals = Object.values(stats);
  return vals[0] as ReturnType<typeof firstStats>;
}

/**
 * Map raw Cornerstone annotations (+ pre-normalized overlay handles) into
 * FindingMeasurement[]. Handles must already be [0,1] image/overlay space.
 */
export function normalizeMeasurements(
  annotations: Array<{
    raw: RawAnnotationLike;
    handlesPct: Array<[number, number]>;
    sopInstanceUID?: string;
    sliceIndex?: number;
  }>
): FindingMeasurement[] {
  const out: FindingMeasurement[] = [];
  for (let i = 0; i < annotations.length; i++) {
    const { raw, handlesPct, sopInstanceUID, sliceIndex } = annotations[i];
    const tool = raw.metadata?.toolName;
    const kind = tool ? TOOL_KIND[tool] : undefined;
    if (!kind || handlesPct.length === 0) continue;
    const stats = firstStats(raw.data);
    const unit =
      stats?.modalityUnit ||
      (stats?.Modality === "CT" ? "HU" : undefined) ||
      stats?.unit;

    const m: FindingMeasurement = {
      id: raw.annotationUID || `meas_${i}`,
      kind,
      handles: handlesPct,
      label: raw.data?.label || undefined,
      sopInstanceUID,
      sliceIndex,
    };

    if (kind === "length" || kind === "bidirectional") {
      if (stats?.length != null && Number.isFinite(stats.length)) {
        m.lengthMm = stats.length;
      }
      if (stats?.unit) m.unit = String(stats.unit);
    }

    if (kind === "ellipse") {
      if (stats?.mean != null && Number.isFinite(stats.mean)) m.meanHu = stats.mean;
      if (stats?.max != null && Number.isFinite(stats.max)) m.maxHu = stats.max;
      if (stats?.min != null && Number.isFinite(stats.min)) m.minHu = stats.min;
      if (stats?.stdDev != null && Number.isFinite(stats.stdDev)) m.stdHu = stats.stdDev;
      if (stats?.area != null && Number.isFinite(stats.area)) m.areaMm2 = stats.area;
      if (unit) m.unit = String(unit);
    }

    if (kind === "probe") {
      // Probe often stores value as mean or in unit field — keep meanHu when CT.
      if (stats?.mean != null && Number.isFinite(stats.mean)) m.meanHu = stats.mean;
      if (unit) m.unit = String(unit);
    }

    out.push(m);
  }
  return out;
}

function finiteNum(n: number | undefined): number | undefined {
  return n != null && Number.isFinite(n) ? n : undefined;
}

/** Numeric payload for a record event, read off Cornerstone cachedStats. */
export function statsFromAnnotation(raw: RawAnnotationLike): {
  lengthMm?: number;
  meanHu?: number;
  maxHu?: number;
  minHu?: number;
  stdHu?: number;
  areaMm2?: number;
  unit?: string;
  label?: string;
} {
  const stats = firstStats(raw.data);
  const unit =
    stats?.modalityUnit ||
    (stats?.Modality === "CT" ? "HU" : undefined) ||
    stats?.unit;
  return {
    lengthMm: finiteNum(stats?.length),
    meanHu: finiteNum(stats?.mean),
    maxHu: finiteNum(stats?.max),
    minHu: finiteNum(stats?.min),
    stdHu: finiteNum(stats?.stdDev),
    areaMm2: finiteNum(stats?.area),
    unit: unit ? String(unit) : undefined,
    label: raw.data?.label || undefined,
  };
}

function kindFromTool(tool?: string, shape?: RecordedAnnotation["shape"]): FindingMeasurementKind | undefined {
  if (tool && TOOL_KIND[tool]) return TOOL_KIND[tool];
  if (shape === "arrow") return "arrow";
  return undefined;
}

/** One recorded stroke → a FindingMeasurement, or null if it has no handles. */
export function measurementFromAnnotationEvent(
  e: Extract<RecordedEvent, { type: "annotation" }>,
  index = 0
): FindingMeasurement | null {
  const handles = (e.handles?.length ? e.handles : [e.from, e.to]).filter(
    (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  const kind = kindFromTool(e.tool, e.shape);
  if (!kind || handles.length === 0) return null;
  const m: FindingMeasurement = {
    id: e.annotationUID || `ann_${index}`,
    kind,
    handles,
    label: e.label,
    sliceIndex: e.sliceIndex,
  };
  if (e.lengthMm != null && Number.isFinite(e.lengthMm)) m.lengthMm = e.lengthMm;
  if (e.meanHu != null && Number.isFinite(e.meanHu)) m.meanHu = e.meanHu;
  if (e.maxHu != null && Number.isFinite(e.maxHu)) m.maxHu = e.maxHu;
  if (e.minHu != null && Number.isFinite(e.minHu)) m.minHu = e.minHu;
  if (e.stdHu != null && Number.isFinite(e.stdHu)) m.stdHu = e.stdHu;
  if (e.areaMm2 != null && Number.isFinite(e.areaMm2)) m.areaMm2 = e.areaMm2;
  if (e.unit) m.unit = e.unit;
  return m;
}

/**
 * Last stroke per annotation id on a track. Used when the live viewport
 * snapshot is empty but the recording captured Length / ROI / Arrow.
 */
export function measurementsFromTrack(track: RecordedTrack | null | undefined): FindingMeasurement[] {
  if (!track?.events?.length) return [];
  const byKey = new Map<string, FindingMeasurement>();
  let n = 0;
  for (const e of track.events) {
    if (e.type !== "annotation") continue;
    const m = measurementFromAnnotationEvent(e, n++);
    if (!m) continue;
    byKey.set(e.annotationUID || m.id, m);
  }
  return [...byKey.values()];
}

/** Live viewport snapshot wins on id; track strokes fill anything missing. */
export function mergeMeasurements(
  live: FindingMeasurement[] | undefined,
  fromTrack: FindingMeasurement[] | undefined
): FindingMeasurement[] {
  const primary = live ?? [];
  const extra = fromTrack ?? [];
  if (primary.length === 0) return extra;
  const ids = new Set(primary.map((m) => m.id));
  return [...primary, ...extra.filter((m) => !ids.has(m.id))];
}

/** Compact tutor/context line for a measurement. */
export function formatMeasurementBrief(m: FindingMeasurement): string {
  if (m.kind === "length" && m.lengthMm != null) {
    return `length ${m.lengthMm.toFixed(1)}${m.unit || "mm"}`;
  }
  if (m.kind === "ellipse") {
    const bits: string[] = [];
    if (m.meanHu != null) bits.push(`mean ${m.meanHu.toFixed(0)}${m.unit || "HU"}`);
    if (m.areaMm2 != null) bits.push(`area ${m.areaMm2.toFixed(1)}mm²`);
    return bits.length ? `ROI ${bits.join(", ")}` : "ellipse ROI";
  }
  if (m.kind === "probe" && m.meanHu != null) {
    return `probe ${m.meanHu.toFixed(0)}${m.unit || "HU"}`;
  }
  if (m.kind === "bidirectional" && m.lengthMm != null) {
    return `diameter ${m.lengthMm.toFixed(1)}${m.unit || "mm"}`;
  }
  if (m.kind === "arrow") return m.label ? `arrow "${m.label}"` : "arrow";
  if (m.kind === "angle") return "angle";
  return m.kind;
}
