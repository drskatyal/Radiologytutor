// Measurements as a list and as report text: the free viewer's Measurements
// panel (and anything else that wants them). Pure: it reads the annotation
// records Cornerstone keeps (tool name, cached stats, the image they sit on)
// and returns rows a reader can scan, jump to and paste into a report.
//
// Only numbers the tools computed are shown; nothing is estimated here.
// Values are rounded for reading (1 decimal for mm, cm², HU and degrees),
// never re-derived. A measurement whose stats are not ready yet is listed as
// "measuring…" rather than dropped, so the list matches the image.

/** The subset of a Cornerstone annotation this module reads. */
export interface AnnotationLike {
  annotationUID?: string;
  metadata?: { toolName?: string; referencedImageId?: string };
  data?: {
    label?: string;
    text?: string;
    cachedStats?: Record<string, Record<string, unknown> | undefined>;
  };
}

/** Where an image sits, for the row's location column. */
export interface ImagePlace {
  /** e.g. "CT Se 2" (modality and series number; never patient details). */
  series: string;
  /** 1-based image number in its stack. */
  image: number;
}

export interface MeasurementRow {
  uid: string;
  imageId: string;
  /** "Length", "Angle", "Ellipse ROI"… */
  kind: string;
  /** "23.4 mm", "Mean 42.1 HU · SD 8.0 · Area 3.20 cm²"… or "measuring…". */
  value: string;
  /** The reader's own label, if any. */
  label?: string;
  place?: ImagePlace;
}

const KIND: Record<string, string> = {
  Length: "Length",
  Angle: "Angle",
  CobbAngle: "Cobb angle",
  Bidirectional: "Bidirectional",
  EllipticalROI: "Ellipse ROI",
  RectangleROI: "Rectangle ROI",
  CircleROI: "Circle ROI",
  PlanarFreehandROI: "Freehand ROI",
  Probe: "Pixel probe",
  ArrowAnnotate: "Arrow",
};

/** Tools whose annotations are measurements or labels worth listing. */
export const MEASUREMENT_TOOLS: ReadonlySet<string> = new Set(Object.keys(KIND));

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fixed = (v: number, digits: number) => v.toFixed(digits);

/** cm² reads better than mm² for ROIs above 1 cm². */
function areaText(area: number, unit: unknown): string {
  const u = typeof unit === "string" ? unit : "mm²";
  if (u === "mm²" && area >= 100) return `${fixed(area / 100, 2)} cm²`;
  return `${fixed(area, area < 10 ? 2 : 1)} ${u}`;
}

function firstStats(a: AnnotationLike): Record<string, unknown> | null {
  const stats = a.data?.cachedStats;
  if (!stats) return null;
  for (const v of Object.values(stats)) if (v && typeof v === "object") return v;
  return null;
}

/** The value text for one annotation, or null when its stats are not ready. */
export function measurementValue(a: AnnotationLike): string | null {
  const tool = a.metadata?.toolName ?? "";
  if (tool === "ArrowAnnotate") return a.data?.text?.trim() ? `“${a.data.text.trim()}”` : "(no text)";
  const s = firstStats(a);
  if (!s) return null;
  const unit = typeof s.unit === "string" ? s.unit : "mm";
  switch (tool) {
    case "Length": {
      const length = num(s.length);
      return length == null ? null : `${fixed(length, 1)} ${unit}`;
    }
    case "Angle":
    case "CobbAngle": {
      const angle = num(s.angle);
      return angle == null ? null : `${fixed(angle, 1)}°`;
    }
    case "Bidirectional": {
      const length = num(s.length);
      const width = num(s.width);
      return length == null || width == null ? null : `${fixed(length, 1)} × ${fixed(width, 1)} ${unit}`;
    }
    case "EllipticalROI":
    case "RectangleROI":
    case "CircleROI":
    case "PlanarFreehandROI": {
      const mean = num(s.mean);
      const sd = num(s.stdDev);
      const area = num(s.area);
      if (mean == null && area == null) return null;
      const mu = typeof s.modalityUnit === "string" && s.modalityUnit ? ` ${s.modalityUnit}` : "";
      const parts: string[] = [];
      if (mean != null) parts.push(`Mean ${fixed(mean, 1)}${mu}`);
      if (sd != null) parts.push(`SD ${fixed(sd, 1)}`);
      if (area != null) parts.push(`Area ${areaText(area, s.areaUnit)}`);
      return parts.join(" · ");
    }
    case "Probe": {
      const value = num(s.value);
      const mu = typeof s.modalityUnit === "string" && s.modalityUnit ? ` ${s.modalityUnit}` : "";
      return value == null ? null : `${fixed(value, 1)}${mu}`;
    }
    default:
      return null;
  }
}

/**
 * Rows for every listed annotation, in a stable reading order: by series,
 * then image, then the order they were made. `placeOf` names an image's
 * series and number (null when the image is not in the open study).
 */
export function measurementRows(annotations: readonly AnnotationLike[], placeOf: (imageId: string) => ImagePlace | null): MeasurementRow[] {
  const rows: (MeasurementRow & { order: number })[] = [];
  annotations.forEach((a, order) => {
    const tool = a.metadata?.toolName ?? "";
    const imageId = a.metadata?.referencedImageId ?? "";
    if (!MEASUREMENT_TOOLS.has(tool) || !a.annotationUID || !imageId) return;
    const label = a.data?.label?.trim() || undefined;
    rows.push({
      uid: a.annotationUID,
      imageId,
      kind: KIND[tool]!,
      value: measurementValue(a) ?? "measuring…",
      label,
      place: placeOf(imageId) ?? undefined,
      order,
    });
  });
  rows.sort((x, y) => {
    const s = (x.place?.series ?? "￿").localeCompare(y.place?.series ?? "￿", undefined, { numeric: true });
    if (s) return s;
    const i = (x.place?.image ?? Infinity) - (y.place?.image ?? Infinity);
    return i || x.order - y.order;
  });
  return rows.map(({ order: _order, ...row }) => row);
}

/**
 * Report text: one numbered line per measurement, e.g.
 * "1. Length 23.4 mm — CT Se 2, Im 31". Labels lead when the reader set one.
 */
export function measurementReportText(rows: readonly MeasurementRow[]): string {
  return rows
    .map((r, i) => {
      const what = r.label ? `${r.label} (${r.kind.toLowerCase()})` : r.kind;
      const where = r.place ? ` — ${r.place.series}, Im ${r.place.image}` : "";
      return `${i + 1}. ${what} ${r.value}${where}`;
    })
    .join("\n");
}
