// Phase 2, P2.3: annotations on native viewports. Pure model + store, no DOM.
//
// Points are IMAGE pixel coordinates (col, row), so an annotation stays on the
// anatomy through zoom, pan, rotate and flip (the page maps them with the
// native transform). Each annotation belongs to one image of one series.
// Lengths use Pixel Spacing (mm); ROI statistics come from Rust (the decoded
// modality values), never from screen pixels.

export type ToolName =
  | "Length"
  | "Angle"
  | "CobbAngle"
  | "Bidirectional"
  | "EllipticalROI"
  | "CircleROI"
  | "RectangleROI"
  | "PlanarFreehandROI"
  | "Probe"
  | "ArrowAnnotate";

export const ANNOTATION_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  "Length",
  "Angle",
  "CobbAngle",
  "Bidirectional",
  "EllipticalROI",
  "CircleROI",
  "RectangleROI",
  "PlanarFreehandROI",
  "Probe",
  "ArrowAnnotate",
]);

export type Pt = [number, number];

export interface RoiStats {
  mean: number;
  sd: number;
  min: number;
  max: number;
  pixels: number;
  areaMm2: number;
}

export interface Annotation {
  id: string;
  tool: ToolName;
  seriesUid: string;
  imageIndex: number;
  points: Pt[];
  label?: string;
  /** ROI tools: filled in from Rust after drawing / editing. */
  stats?: RoiStats | null;
  /** Probe: the modality value under the point. */
  value?: number | null;
}

/** Points a tool needs before it is complete (drag tools: 2; freehand: open). */
export function pointsNeeded(tool: ToolName): number {
  switch (tool) {
    case "Angle":
      return 3;
    case "CobbAngle":
      return 4;
    case "Probe":
      return 1;
    case "PlanarFreehandROI":
      return Infinity;
    default:
      return 2;
  }
}

/** Drag tools are drawn with one press-drag-release; the others by clicks. */
export function isDragTool(tool: ToolName): boolean {
  return pointsNeeded(tool) === 2 || tool === "PlanarFreehandROI";
}

/** [row spacing, column spacing] mm per pixel (DICOM Pixel Spacing order). */
export type Spacing = [number, number];

export function distanceMm(a: Pt, b: Pt, s: Spacing): number {
  return Math.hypot((b[0] - a[0]) * s[1], (b[1] - a[1]) * s[0]);
}

function angleBetween(u: Pt, v: Pt): number {
  const dot = u[0] * v[0] + u[1] * v[1];
  const n = Math.hypot(...u) * Math.hypot(...v);
  return n ? (Math.acos(Math.max(-1, Math.min(1, dot / n))) * 180) / Math.PI : 0;
}

/** Physical vector (mm) from a to b. */
const mm = (a: Pt, b: Pt, s: Spacing): Pt => [(b[0] - a[0]) * s[1], (b[1] - a[1]) * s[0]];

/** Angle at the middle point (degrees, 0–180). */
export function angleDeg(p: Pt[], s: Spacing): number {
  if (p.length < 3) return 0;
  return angleBetween(mm(p[1], p[0], s), mm(p[1], p[2], s));
}

/** Cobb angle between line p0–p1 and line p2–p3 (degrees, 0–90). */
export function cobbDeg(p: Pt[], s: Spacing): number {
  if (p.length < 4) return 0;
  const a = angleBetween(mm(p[0], p[1], s), mm(p[2], p[3], s));
  return a > 90 ? 180 - a : a;
}

/**
 * Bidirectional: the long axis is p0–p1; the short axis is perpendicular,
 * through the midpoint, `ratio` of the long axis (default half), so it can be
 * drawn with one drag and adjusted later by moving its ends (p2, p3).
 */
export function bidirectionalPoints(a: Pt, b: Pt, ratio = 0.5): Pt[] {
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const half = (Math.hypot(dx, dy) * ratio) / 2;
  const n = Math.hypot(dx, dy) || 1;
  const px = (-dy / n) * half;
  const py = (dx / n) * half;
  return [a, b, [mid[0] + px, mid[1] + py], [mid[0] - px, mid[1] - py]];
}

/** The text shown next to an annotation. */
export function measureText(a: Annotation, s: Spacing): string {
  const p = a.points;
  switch (a.tool) {
    case "Length":
      return `${distanceMm(p[0], p[1], s).toFixed(1)} mm`;
    case "Angle":
      return `${angleDeg(p, s).toFixed(1)}°`;
    case "CobbAngle":
      return `${cobbDeg(p, s).toFixed(1)}°`;
    case "Bidirectional":
      return `${distanceMm(p[0], p[1], s).toFixed(1)} × ${distanceMm(p[2], p[3], s).toFixed(1)} mm`;
    case "Probe":
      return a.value == null ? "–" : `${Math.round(a.value)}`;
    case "ArrowAnnotate":
      return a.label ?? "";
    default: {
      const st = a.stats;
      if (!st) return "…";
      const area = st.areaMm2 >= 100 ? `${(st.areaMm2 / 100).toFixed(2)} cm²` : `${st.areaMm2.toFixed(1)} mm²`;
      return `Mean ${st.mean.toFixed(1)} · SD ${st.sd.toFixed(1)} · ${area}`;
    }
  }
}

/** The Rust ROI shape for an ROI annotation (null for other tools). */
export function roiShape(a: Annotation): { kind: "rect" | "ellipse"; a: Pt; b: Pt } | { kind: "polygon"; points: Pt[] } | null {
  const p = a.points;
  switch (a.tool) {
    case "RectangleROI":
      return { kind: "rect", a: p[0], b: p[1] };
    case "EllipticalROI":
      return { kind: "ellipse", a: p[0], b: p[1] };
    case "CircleROI": {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
      return { kind: "ellipse", a: [p[0][0] - r, p[0][1] - r], b: [p[0][0] + r, p[0][1] + r] };
    }
    case "PlanarFreehandROI":
      return p.length >= 3 ? { kind: "polygon", points: p } : null;
    default:
      return null;
  }
}

/** Distance from point q to segment a–b (any units). */
export function segmentDistance(q: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
}

/** The drawn outline of an annotation as segments (image space). */
export function segments(a: Annotation): [Pt, Pt][] {
  const p = a.points;
  const chain = (q: Pt[]): [Pt, Pt][] => q.slice(1).map((b, i) => [q[i], b]);
  const ring = (cx: number, cy: number, rx: number, ry: number): [Pt, Pt][] =>
    chain(Array.from({ length: 37 }, (_, i) => [cx + rx * Math.cos((i / 36) * 2 * Math.PI), cy + ry * Math.sin((i / 36) * 2 * Math.PI)] as Pt));
  if (p.length < 2) return [];
  switch (a.tool) {
    case "RectangleROI":
      return chain([p[0], [p[1][0], p[0][1]], p[1], [p[0][0], p[1][1]], p[0]]);
    case "EllipticalROI":
      // The ellipse inscribed in the drag box (what Shape draws), not the box.
      return ring((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2, Math.abs(p[1][0] - p[0][0]) / 2, Math.abs(p[1][1] - p[0][1]) / 2);
    case "CircleROI": {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
      return ring(p[0][0], p[0][1], r, r);
    }
    case "PlanarFreehandROI":
      return chain([...p, p[0]]);
    case "CobbAngle":
    case "Bidirectional":
      return p.length >= 4 ? [[p[0], p[1]], [p[2], p[3]]] : chain(p);
    default:
      return chain(p);
  }
}

const CLOSED = new Set(["RectangleROI", "EllipticalROI", "CircleROI", "PlanarFreehandROI"]);

function insidePolygon(q: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The annotation under screen point `q` (topmost first), by distance to its
 * drawn segments in SCREEN px: a click anywhere along a measurement line hits
 * it, not just near its end points. `toScreen` maps image → cell px.
 * `insideCloses`: the eraser also takes a click inside a closed ROI.
 */
export function hitAnnotation(
  list: readonly Annotation[],
  q: Pt,
  toScreen: (p: Pt) => Pt,
  tolerancePx: number,
  opts: { selected?: string | null; handlePx?: number; insideCloses?: boolean } = {}
): { a: Annotation; handle: number | "body" } | null {
  for (const a of [...list].reverse()) {
    const pts = a.points.map(toScreen);
    if (a.id === opts.selected) {
      const h = pts.findIndex((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= (opts.handlePx ?? tolerancePx));
      if (h >= 0) return { a, handle: h };
    }
    const segs = segments(a).map(([s0, s1]) => [toScreen(s0), toScreen(s1)] as [Pt, Pt]);
    if (segs.some(([s0, s1]) => segmentDistance(q, s0, s1) <= tolerancePx)) return { a, handle: "body" };
    if (pts.length === 1 && Math.hypot(pts[0][0] - q[0], pts[0][1] - q[1]) <= tolerancePx) return { a, handle: "body" };
    if (opts.insideCloses && CLOSED.has(a.tool) && segs.length && insidePolygon(q, segs.map((s) => s[0]))) return { a, handle: "body" };
  }
  return null;
}

// ───────────── store: per study, with undo / redo ─────────────

type Op = { kind: "add" | "remove"; items: Annotation[] } | { kind: "update"; before: Annotation; after: Annotation };

const items = new Map<string, Annotation>();
const undoStack: Op[] = [];
const redoStack: Op[] = [];
const listeners = new Set<() => void>();
let seq = 0;

const emit = () => listeners.forEach((l) => l());

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function newId(): string {
  seq += 1;
  return `na-${Date.now().toString(36)}-${seq}`;
}

export function annotationsFor(seriesUid: string, imageIndex: number): Annotation[] {
  return [...items.values()].filter((a) => a.seriesUid === seriesUid && a.imageIndex === imageIndex);
}

export function allAnnotations(): Annotation[] {
  return [...items.values()];
}

function apply(op: Op, reverse: boolean) {
  if (op.kind === "update") {
    const a = reverse ? op.before : op.after;
    items.set(a.id, a);
    return;
  }
  const adding = (op.kind === "add") !== reverse;
  for (const a of op.items) {
    if (adding) items.set(a.id, a);
    else items.delete(a.id);
  }
}

function record(op: Op) {
  apply(op, false);
  undoStack.push(op);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  emit();
}

export function addAnnotation(a: Annotation): void {
  record({ kind: "add", items: [a] });
}

export function updateAnnotation(next: Annotation, { undoable = true } = {}): void {
  const before = items.get(next.id);
  if (!before) return;
  if (!undoable) {
    items.set(next.id, next);
    emit();
    return;
  }
  record({ kind: "update", before, after: next });
}

export function removeAnnotations(ids: readonly string[]): number {
  const gone = ids.map((id) => items.get(id)).filter((a): a is Annotation => !!a);
  if (gone.length) record({ kind: "remove", items: gone });
  return gone.length;
}

export function undo(): boolean {
  const op = undoStack.pop();
  if (!op) return false;
  apply(op, true);
  redoStack.push(op);
  emit();
  return true;
}

export function redo(): boolean {
  const op = redoStack.pop();
  if (!op) return false;
  apply(op, false);
  undoStack.push(op);
  emit();
  return true;
}

// F12: annotations hidden (kept, not drawn), the same switch as the JS path.
let hidden = false;
export function setAnnotationsHidden(v: boolean): void {
  if (hidden === v) return;
  hidden = v;
  emit();
}
export function annotationsHidden(): boolean {
  return hidden;
}

/** Study closed. */
export function clearAnnotations(): void {
  items.clear();
  undoStack.length = 0;
  redoStack.length = 0;
  emit();
}
