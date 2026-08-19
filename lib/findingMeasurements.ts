/**
 * Normalize Cornerstone annotation tools into durable FindingMeasurement rows.
 * Tools draw in world space; we persist overlay [0,1] handles + numeric stats
 * (mm / HU) so tutors and student UI can teach without re-querying voxels.
 */

import type { FindingMeasurement, FindingMeasurementKind } from "./types";

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
  return m.kind;
}
