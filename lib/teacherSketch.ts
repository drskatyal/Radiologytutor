/**
 * Teacher sketch layer — pure model.
 *
 * The Recording Studio lets a teacher draw on the DICOM image while they
 * narrate: pen, arrow, ellipse, text, eraser, undo, and M for a numbered,
 * labelled finding marker. Each edit is a `TeacherSketchOp`. Ops ride the
 * recorder timeline as `{ type: "sketch" }` events next to scroll / window /
 * cursor, so:
 *
 *   • replay folds the ops in time order and draws each pen stroke back at the
 *     speed it was drawn (per-point `dt`),
 *   • the Gemini compile sees "t=… marker #2 'apical nodule'" on the clock and
 *     can segment narration around it,
 *   • a finding's landing prefers the teacher's own marker over a cursor
 *     sample, and the AI sketch tool redraws at the teacher's exact marks
 *     (authored coordinates only — never model-invented ones).
 *
 * Everything here is pure (no DOM, no Cornerstone) so it is unit-tested.
 */

import { fractionToIndex, indexToPatient, type SketchFrameImage } from "./sketchProjection";
import type {
  Marker,
  NarrationSpan,
  RecordedEvent,
  RecordedTrack,
  SketchImagePoint,
  SketchImageRef,
  TeacherSketchItem,
  TeacherSketchKind,
  TeacherSketchOp,
} from "./types";

export type SketchEvent = Extract<RecordedEvent, { type: "sketch" }>;

/** Tools in the Studio palette. `select` hands the mouse back to the viewer. */
export type TeacherSketchTool = "select" | "pen" | "arrow" | "ellipse" | "text" | "marker" | "eraser";

export const TEACHER_SKETCH_KINDS: readonly TeacherSketchKind[] = ["pen", "arrow", "ellipse", "text", "marker"];

/** Hard caps so a runaway gesture can't bloat a saved case. */
export const SKETCH_LIMITS = {
  pointsPerStroke: 600,
  itemsPerTake: 400,
  textChars: 140,
} as const;

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Strip geometry the item does not need to carry (the plane lives on points as mm). */
export function imageRefFrom(image: SketchFrameImage | undefined, sliceIndex: number): SketchImageRef {
  const ref: SketchImageRef = { sliceIndex };
  if (!image) return ref;
  if (image.studyInstanceUID) ref.studyInstanceUID = image.studyInstanceUID;
  if (image.seriesInstanceUID) ref.seriesInstanceUID = image.seriesInstanceUID;
  if (image.sopInstanceUID) ref.sopInstanceUID = image.sopInstanceUID;
  if (image.sopClassUID) ref.sopClassUID = image.sopClassUID;
  if (image.frameNumber != null && Number.isFinite(image.frameNumber)) ref.frameNumber = image.frameNumber;
  if (image.columns) ref.columns = image.columns;
  if (image.rows) ref.rows = image.rows;
  if (image.frameOfReferenceUID) ref.frameOfReferenceUID = image.frameOfReferenceUID;
  if (image.plane) {
    ref.plane = {
      imagePositionPatient: [...image.plane.imagePositionPatient],
      rowCosines: [...image.plane.rowCosines],
      columnCosines: [...image.plane.columnCosines],
      pixelSpacing: [...image.plane.pixelSpacing],
    };
  }
  return ref;
}

/**
 * An image fraction → a fully anchored point: fraction (back-compat), pixel
 * index, and patient mm when the plane is known.
 */
export function anchorPoint(
  xPct: number,
  yPct: number,
  image?: SketchFrameImage,
  dt?: number
): SketchImagePoint {
  const point: SketchImagePoint = { x_pct: round(xPct, 5), y_pct: round(yPct, 5) };
  const columns = image?.columns ?? image?.plane?.columns;
  const rows = image?.rows ?? image?.plane?.rows;
  if (columns && rows) {
    const idx = fractionToIndex(xPct, yPct, columns, rows);
    if (idx) {
      point.col = round(idx.col, 3);
      point.row = round(idx.row, 3);
      const mm = indexToPatient(idx.col, idx.row, image?.plane);
      if (mm) point.mm = [round(mm[0], 3), round(mm[1], 3), round(mm[2], 3)];
    }
  }
  if (dt != null && Number.isFinite(dt)) point.dt = Math.max(0, Math.round(dt));
  return point;
}

// ---------------------------------------------------------------------------
// Reducer + undo
// ---------------------------------------------------------------------------

export function applySketchOp(items: readonly TeacherSketchItem[], op: TeacherSketchOp): TeacherSketchItem[] {
  switch (op.op) {
    case "add": {
      const rest = items.filter((item) => item.id !== op.item.id);
      return [...rest, op.item].slice(-SKETCH_LIMITS.itemsPerTake);
    }
    case "remove":
      return items.filter((item) => item.id !== op.id);
    case "label":
      return items.map((item) => (item.id === op.id ? { ...item, text: op.text } : item));
    case "reset":
      return [...op.items];
    default:
      return [...items];
  }
}

/**
 * The op that undoes `op` against the state it was applied to. Null when the
 * op changed nothing (removing an id that is not there).
 */
export function inverseSketchOp(before: readonly TeacherSketchItem[], op: TeacherSketchOp): TeacherSketchOp | null {
  switch (op.op) {
    case "add": {
      const prior = before.find((item) => item.id === op.item.id);
      return prior ? { op: "add", item: prior } : { op: "remove", id: op.item.id };
    }
    case "remove": {
      const prior = before.find((item) => item.id === op.id);
      return prior ? { op: "add", item: prior } : null;
    }
    case "label": {
      const prior = before.find((item) => item.id === op.id);
      return prior ? { op: "label", id: op.id, text: prior.text ?? "" } : null;
    }
    case "reset":
      return { op: "reset", items: [...before] };
    default:
      return null;
  }
}

/**
 * Undo/redo history over sketch ops. Every move (including an undo) is a new
 * op the caller records, so the timeline replays exactly what the teacher saw.
 */
export interface SketchHistory {
  items: TeacherSketchItem[];
  undo: TeacherSketchOp[];
  redo: TeacherSketchOp[];
}

export const EMPTY_HISTORY: SketchHistory = { items: [], undo: [], redo: [] };

export function commitSketchOp(history: SketchHistory, op: TeacherSketchOp): { history: SketchHistory; applied: TeacherSketchOp | null } {
  const inverse = inverseSketchOp(history.items, op);
  if (!inverse) return { history, applied: null };
  return {
    history: { items: applySketchOp(history.items, op), undo: [...history.undo, inverse].slice(-200), redo: [] },
    applied: op,
  };
}

export function undoSketch(history: SketchHistory): { history: SketchHistory; applied: TeacherSketchOp | null } {
  const op = history.undo[history.undo.length - 1];
  if (!op) return { history, applied: null };
  const inverse = inverseSketchOp(history.items, op);
  return {
    history: {
      items: applySketchOp(history.items, op),
      undo: history.undo.slice(0, -1),
      redo: inverse ? [...history.redo, inverse] : history.redo,
    },
    applied: op,
  };
}

export function redoSketch(history: SketchHistory): { history: SketchHistory; applied: TeacherSketchOp | null } {
  const op = history.redo[history.redo.length - 1];
  if (!op) return { history, applied: null };
  const inverse = inverseSketchOp(history.items, op);
  return {
    history: {
      items: applySketchOp(history.items, op),
      undo: inverse ? [...history.undo, inverse] : history.undo,
      redo: history.redo.slice(0, -1),
    },
    applied: op,
  };
}

/** Next marker number for this take: one more than the highest still shown. */
export function nextMarkerNumber(items: readonly TeacherSketchItem[]): number {
  let max = 0;
  for (const item of items) if (item.kind === "marker" && item.number && item.number > max) max = item.number;
  return max + 1;
}

export function defaultMarkerLabel(number: number): string {
  return `Finding ${number}`;
}

// ---------------------------------------------------------------------------
// Timeline (progressive replay)
// ---------------------------------------------------------------------------

export function isSketchEvent(event: RecordedEvent): event is SketchEvent {
  return event.type === "sketch";
}

export function sketchOpOf(event: SketchEvent): TeacherSketchOp {
  const { t: _t, type: _type, ...op } = event;
  return op as TeacherSketchOp;
}

export interface PlacedSketchItem {
  item: TeacherSketchItem;
  /** Track ms when the item's add op fired (the stroke's first point). */
  addedAt: number;
}

/** Items on screen at `tMs`, each with the time it started drawing. */
export function sketchItemsAt(events: readonly RecordedEvent[], tMs: number): PlacedSketchItem[] {
  let placed: PlacedSketchItem[] = [];
  for (const event of events) {
    if (event.t > tMs) break;
    if (!isSketchEvent(event)) continue;
    const op = sketchOpOf(event);
    if (op.op === "add") {
      placed = [...placed.filter((p) => p.item.id !== op.item.id), { item: op.item, addedAt: event.t }];
    } else if (op.op === "remove") {
      placed = placed.filter((p) => p.item.id !== op.id);
    } else if (op.op === "label") {
      placed = placed.map((p) => (p.item.id === op.id ? { ...p, item: { ...p.item, text: op.text } } : p));
    } else if (op.op === "reset") {
      placed = op.items.map((item) => ({ item, addedAt: event.t }));
    }
  }
  return placed;
}

/** Final sketch state of a whole track. */
export function sketchItemsOf(track: Pick<RecordedTrack, "events"> | null | undefined): TeacherSketchItem[] {
  if (!track?.events?.length) return [];
  return sketchItemsAt(track.events, Number.POSITIVE_INFINITY).map((p) => p.item);
}

/** How far a stroke has drawn `elapsedMs` after it began, 0..1. */
export function strokeProgress(item: TeacherSketchItem, elapsedMs: number): number {
  const total = item.drawMs ?? 0;
  if (!(total > 0)) return 1;
  if (elapsedMs <= 0) return 0;
  return Math.min(1, elapsedMs / total);
}

/** The points a stroke shows `elapsedMs` after it began (pen uses `dt`). */
export function revealedPoints(item: TeacherSketchItem, elapsedMs: number): SketchImagePoint[] {
  if (strokeProgress(item, elapsedMs) >= 1) return item.points;
  if (item.kind !== "pen") return elapsedMs > 0 ? item.points : [];
  const timed = item.points.every((p) => p.dt != null);
  if (timed) {
    const out = item.points.filter((p) => (p.dt ?? 0) <= elapsedMs);
    return out.length ? out : item.points.slice(0, 1);
  }
  const n = Math.max(1, Math.ceil(item.points.length * strokeProgress(item, elapsedMs)));
  return item.points.slice(0, n);
}

// ---------------------------------------------------------------------------
// Visibility: a stroke shows on its own image only
// ---------------------------------------------------------------------------

export interface SketchView {
  sliceIndex: number;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  frameNumber?: number;
}

export function itemOnImage(item: Pick<TeacherSketchItem, "image">, view: SketchView | null | undefined): boolean {
  if (!view) return false;
  const ref = item.image;
  if (ref.seriesInstanceUID && view.seriesInstanceUID && ref.seriesInstanceUID !== view.seriesInstanceUID) return false;
  if (ref.sopInstanceUID && view.sopInstanceUID) {
    if (ref.sopInstanceUID !== view.sopInstanceUID) return false;
    if (ref.frameNumber != null && view.frameNumber != null) return ref.frameNumber === view.frameNumber;
    return true;
  }
  return ref.sliceIndex === view.sliceIndex;
}

// ---------------------------------------------------------------------------
// Eraser hit-test (screen pixels through the live projector)
// ---------------------------------------------------------------------------

type Project = (xPct: number, yPct: number) => { x: number; y: number } | null;

function distToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Screen distance from (x,y) to the item's ink. Infinity when it can't project. */
export function distanceToItem(item: TeacherSketchItem, project: Project, x: number, y: number): number {
  const pts = item.points.map((p) => project(p.x_pct, p.y_pct)).filter((p): p is { x: number; y: number } => !!p);
  if (!pts.length) return Number.POSITIVE_INFINITY;
  if (item.kind === "text" || item.kind === "marker" || pts.length === 1) {
    return Math.max(0, Math.hypot(x - pts[0]!.x, y - pts[0]!.y) - (item.kind === "marker" ? 12 : 4));
  }
  if (item.kind === "ellipse") {
    const [a, b] = [pts[0]!, pts[pts.length - 1]!];
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.max(1, Math.abs(b.x - a.x) / 2);
    const ry = Math.max(1, Math.abs(b.y - a.y) / 2);
    let best = Number.POSITIVE_INFINITY;
    let prev: { x: number; y: number } | null = null;
    for (let i = 0; i <= 48; i++) {
      const th = (i / 48) * Math.PI * 2;
      const p = { x: cx + rx * Math.cos(th), y: cy + ry * Math.sin(th) };
      if (prev) best = Math.min(best, distToSegment(x, y, prev, p));
      prev = p;
    }
    return best;
  }
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(x, y, pts[i - 1]!, pts[i]!));
  return best;
}

/** Topmost item within `tolerance` px of (x,y) on this image, or null. */
export function hitTestSketch(
  items: readonly TeacherSketchItem[],
  view: SketchView,
  project: Project,
  x: number,
  y: number,
  tolerance = 10
): TeacherSketchItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (!itemOnImage(item, view)) continue;
    if (distanceToItem(item, project, x, y) <= tolerance) return item;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Narration links (Gemini compile, teaching guide, export sidecar)
// ---------------------------------------------------------------------------

export interface SketchTimelineEntry {
  id: string;
  kind: TeacherSketchKind;
  /** Track ms the item started drawing. */
  tMs: number;
  /** Track ms the gesture finished. */
  tEndMs: number;
  number?: number;
  /** Final label / text after any later label edits. */
  label?: string;
  image: SketchImageRef;
  /** Still on screen at the end of the take. */
  kept: boolean;
}

/** One row per item ever added, in time order, with its final label. */
export function sketchTimeline(events: readonly RecordedEvent[]): SketchTimelineEntry[] {
  const rows = new Map<string, SketchTimelineEntry>();
  const order: string[] = [];
  const alive = new Set<string>();
  for (const event of events) {
    if (!isSketchEvent(event)) continue;
    const op = sketchOpOf(event);
    const upsert = (item: TeacherSketchItem, t: number) => {
      if (!rows.has(item.id)) order.push(item.id);
      rows.set(item.id, {
        id: item.id,
        kind: item.kind,
        tMs: t,
        tEndMs: t + Math.max(0, item.drawMs ?? 0),
        ...(item.number != null ? { number: item.number } : {}),
        ...(item.text ? { label: item.text } : {}),
        image: item.image,
        kept: true,
      });
      alive.add(item.id);
    };
    if (op.op === "add") upsert(op.item, event.t);
    else if (op.op === "remove") alive.delete(op.id);
    else if (op.op === "label") {
      const row = rows.get(op.id);
      if (row) rows.set(op.id, { ...row, label: op.text });
    } else if (op.op === "reset") {
      alive.clear();
      for (const item of op.items) {
        if (rows.has(item.id)) alive.add(item.id);
        else upsert(item, event.t);
      }
    }
  }
  return order.map((id) => ({ ...rows.get(id)!, kept: alive.has(id) }));
}

export interface SketchNarrationLink extends SketchTimelineEntry {
  /** Index into the narration spans, or null when no span is near. */
  spanIndex: number | null;
  /** The sentence the teacher was saying while drawing it. */
  said?: string;
}

/**
 * Tie each sketch item to the narration span it was drawn under. A stroke
 * drawn in a pause links to the nearest span within `slackMs`.
 */
export function linkSketchesToNarration(
  events: readonly RecordedEvent[],
  spans: readonly NarrationSpan[] | null | undefined,
  slackMs = 1500
): SketchNarrationLink[] {
  const list = spans ?? [];
  return sketchTimeline(events).map((row) => {
    const t = row.tMs;
    let index = list.findIndex((span) => t >= span.tStartMs && t <= span.tEndMs);
    if (index < 0) {
      let best = Number.POSITIVE_INFINITY;
      list.forEach((span, i) => {
        const gap = t < span.tStartMs ? span.tStartMs - t : t - span.tEndMs;
        if (gap < best && gap <= slackMs) {
          best = gap;
          index = i;
        }
      });
    }
    const span = index >= 0 ? list[index] : undefined;
    return { ...row, spanIndex: index >= 0 ? index : null, ...(span ? { said: span.text } : {}) };
  });
}

function quoted(text: string | undefined): string {
  const clean = (text ?? "").replace(/["\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return clean ? ` "${clean}"` : "";
}

/** Clock lines for the compile prompt. No coordinates — the model never sees positions. */
export function sketchClockLines(events: readonly RecordedEvent[]): string[] {
  return sketchTimeline(events)
    .filter((row) => row.kept)
    .map((row) =>
      row.kind === "marker"
        ? `t=${row.tMs}ms marker #${row.number ?? "?"}${quoted(row.label)} (slice ${row.image.sliceIndex})`
        : `t=${row.tMs}ms sketch ${row.kind}${row.kind === "text" ? quoted(row.label) : ""} (slice ${row.image.sliceIndex})`
    );
}

export interface TeacherMarkerLanding {
  id: string;
  number?: number;
  label?: string;
  marker: Marker;
  sliceIndex: number;
  sopInstanceUID?: string;
  seriesInstanceUID?: string;
  studyInstanceUID?: string;
  frameNumber?: number;
  tMs: number;
}

/**
 * The teacher's own marker for a narration window: the last kept marker
 * dropped inside [tStart, tEnd], else the nearest within `slackMs` either
 * side. These are authored coordinates, so a finding landing prefers them to
 * a cursor sample.
 */
export function teacherMarkerInWindow(
  track: Pick<RecordedTrack, "events"> | null | undefined,
  tStartMs: number,
  tEndMs: number,
  slackMs = 750
): TeacherMarkerLanding | null {
  if (!track?.events?.length) return null;
  const finalItems = new Map(sketchItemsOf(track).map((item) => [item.id, item]));
  const markers = sketchTimeline(track.events).filter((row) => row.kind === "marker" && row.kept);
  if (!markers.length) return null;
  const inside = markers.filter((row) => row.tMs >= tStartMs && row.tMs <= tEndMs);
  let pick = inside[inside.length - 1];
  if (!pick) {
    let best = Number.POSITIVE_INFINITY;
    for (const row of markers) {
      const gap = row.tMs < tStartMs ? tStartMs - row.tMs : row.tMs - tEndMs;
      if (gap <= slackMs && gap < best) {
        best = gap;
        pick = row;
      }
    }
  }
  if (!pick) return null;
  const item = finalItems.get(pick.id);
  const point = item?.points[0];
  if (!item || !point) return null;
  return {
    id: item.id,
    ...(item.number != null ? { number: item.number } : {}),
    ...(item.text ? { label: item.text } : {}),
    marker: { x_pct: point.x_pct, y_pct: point.y_pct, shape: "circle" },
    sliceIndex: item.image.sliceIndex,
    ...(item.image.sopInstanceUID ? { sopInstanceUID: item.image.sopInstanceUID } : {}),
    ...(item.image.seriesInstanceUID ? { seriesInstanceUID: item.image.seriesInstanceUID } : {}),
    ...(item.image.studyInstanceUID ? { studyInstanceUID: item.image.studyInstanceUID } : {}),
    ...(item.image.frameNumber != null ? { frameNumber: item.image.frameNumber } : {}),
    tMs: pick.tMs,
  };
}

/**
 * Teacher arrows and ellipses as the annotation events the teaching guide and
 * replay overlay already draw. Appended to a COPY of the track so the student
 * walk-through points with the teacher's own ink.
 */
export function withSketchAnnotations(track: RecordedTrack): RecordedTrack {
  if (!track.events?.some(isSketchEvent)) return track;
  const kept = new Set(sketchItemsOf(track).map((item) => item.id));
  const extra: RecordedEvent[] = [];
  for (const event of track.events) {
    if (!isSketchEvent(event) || event.op !== "add") continue;
    const item = event.item;
    if (!kept.has(item.id) || item.points.length < 2) continue;
    if (item.kind !== "arrow" && item.kind !== "ellipse") continue;
    const a = item.points[0]!;
    const b = item.points[item.points.length - 1]!;
    const from: [number, number] = [a.x_pct, a.y_pct];
    const to: [number, number] = [b.x_pct, b.y_pct];
    extra.push({
      t: event.t + Math.max(0, item.drawMs ?? 0),
      type: "annotation",
      shape: item.kind === "arrow" ? "arrow" : "circle",
      tool: item.kind === "arrow" ? "ArrowAnnotate" : "EllipticalROI",
      from,
      to,
      handles: [from, to],
      sliceIndex: item.image.sliceIndex,
      annotationUID: `sketch:${item.id}`,
      ...(item.text ? { label: item.text } : {}),
    });
  }
  if (!extra.length) return track;
  return { ...track, events: [...track.events, ...extra].sort((x, y) => x.t - y.t) };
}

// ---------------------------------------------------------------------------
// Validation (API boundary)
// ---------------------------------------------------------------------------

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9.]{1,64}$/.test(value) ? value : undefined;
}

function cleanPoint(raw: unknown): SketchImagePoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = num(r.x_pct);
  const y = num(r.y_pct);
  if (x == null || y == null || x < -0.5 || x > 1.5 || y < -0.5 || y > 1.5) return null;
  const point: SketchImagePoint = { x_pct: x, y_pct: y };
  const col = num(r.col);
  const row = num(r.row);
  if (col != null && row != null) {
    point.col = col;
    point.row = row;
  }
  if (Array.isArray(r.mm) && r.mm.length === 3 && r.mm.every((v) => num(v) != null)) {
    point.mm = [r.mm[0] as number, r.mm[1] as number, r.mm[2] as number];
  }
  const dt = num(r.dt);
  if (dt != null && dt >= 0) point.dt = dt;
  return point;
}

/** Validate one item from an untrusted body. Null when it is unusable. */
export function cleanSketchItem(raw: unknown): TeacherSketchItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as TeacherSketchKind;
  if (!TEACHER_SKETCH_KINDS.includes(kind)) return null;
  const id = typeof r.id === "string" && /^[\w:-]{1,64}$/.test(r.id) ? r.id : null;
  if (!id) return null;
  const imageRaw = (r.image ?? {}) as Record<string, unknown>;
  const sliceIndex = num(imageRaw.sliceIndex);
  if (sliceIndex == null || sliceIndex < 0) return null;
  const image: SketchImageRef = { sliceIndex: Math.round(sliceIndex) };
  for (const key of ["studyInstanceUID", "seriesInstanceUID", "sopInstanceUID", "sopClassUID", "frameOfReferenceUID"] as const) {
    const value = uid(imageRaw[key]);
    if (value) image[key] = value;
  }
  const frameNumber = num(imageRaw.frameNumber);
  if (frameNumber != null && frameNumber >= 1) image.frameNumber = Math.round(frameNumber);
  const columns = num(imageRaw.columns);
  const rows = num(imageRaw.rows);
  if (columns && rows && columns > 0 && rows > 0) {
    image.columns = Math.round(columns);
    image.rows = Math.round(rows);
  }
  const plane = imageRaw.plane as Record<string, unknown> | undefined;
  const vec = (v: unknown, n: number) =>
    Array.isArray(v) && v.length === n && v.every((x) => num(x) != null) ? (v as number[]) : null;
  if (plane && typeof plane === "object") {
    const ipp = vec(plane.imagePositionPatient, 3);
    const rc = vec(plane.rowCosines, 3);
    const cc = vec(plane.columnCosines, 3);
    const ps = vec(plane.pixelSpacing, 2);
    if (ipp && rc && cc && ps && ps[0]! > 0 && ps[1]! > 0) {
      image.plane = {
        imagePositionPatient: [ipp[0]!, ipp[1]!, ipp[2]!],
        rowCosines: [rc[0]!, rc[1]!, rc[2]!],
        columnCosines: [cc[0]!, cc[1]!, cc[2]!],
        pixelSpacing: [ps[0]!, ps[1]!],
      };
    }
  }
  const points = (Array.isArray(r.points) ? r.points : [])
    .slice(0, SKETCH_LIMITS.pointsPerStroke)
    .map(cleanPoint)
    .filter((p): p is SketchImagePoint => !!p);
  const needs = kind === "pen" ? 1 : kind === "arrow" || kind === "ellipse" ? 2 : 1;
  if (points.length < needs) return null;
  const item: TeacherSketchItem = { id, kind, image, points };
  if (typeof r.text === "string" && r.text.trim()) item.text = r.text.replace(/[<>]/g, "").trim().slice(0, SKETCH_LIMITS.textChars);
  const number = num(r.number);
  if (kind === "marker" && number != null && number >= 1) item.number = Math.round(number);
  const drawMs = num(r.drawMs);
  if (drawMs != null && drawMs >= 0) item.drawMs = Math.min(60_000, Math.round(drawMs));
  return item;
}
