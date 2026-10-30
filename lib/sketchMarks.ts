/**
 * Clicky-style marks for the live tutor.
 *
 * The model picks a tool and a finding id (or the learner's visible tap).
 * Geometry is copied from the teaching pack: marker, measurement handles,
 * and the slice window. A coordinate that is not that anchor is rejected.
 * A learner tap is drawn, and it is labelled uncertain.
 *
 * Cards are filled templates. The model never sends HTML.
 */

import type { Finding, FindingMeasurement } from "./types";
import type { LiveFinding, LiveTeachingPack } from "./liveTeachingPack";
import { drawDurationMs } from "./roughStroke";

export const SKETCH_STROKE = {
  yellow: "#FFE14A",
  cyan: "#3EE0FF",
  magenta: "#FF4DDE",
} as const;

export type SketchColor = keyof typeof SKETCH_STROKE;

export type DiagramTemplate = "differential" | "mechanism" | "sign";

export const DIAGRAM_TEMPLATES: readonly DiagramTemplate[] = ["differential", "mechanism", "sign"];

export interface SketchPoint {
  x_pct: number;
  y_pct: number;
}

export interface DiagramCardContent {
  template: DiagramTemplate;
  title: string;
  lines: string[];
}

export interface SketchMark {
  id: string;
  kind: "circle" | "ellipse" | "arrow" | "underline" | "card";
  color: SketchColor;
  certainty: "authored" | "uncertain";
  findingId?: string;
  /** Inclusive. Absent means the mark is not tied to a slice. */
  sliceStart?: number;
  sliceEnd?: number;
  anchor: SketchPoint;
  rx?: number;
  ry?: number;
  from?: SketchPoint;
  to?: SketchPoint;
  points?: SketchPoint[];
  card?: DiagramCardContent;
  /** Shown beside an uncertain stroke. */
  caption?: string;
  delayMs: number;
  durationMs: number;
}

export interface LiveSketchAnchor {
  sliceStart?: number;
  sliceEnd?: number;
  marker: SketchPoint;
  /** Round screen circle. Radii are image fractions. */
  circleRx: number;
  ellipse?: { rx: number; ry: number };
  /** Tip is `to`. Authored handles when the teacher drew one, otherwise a fixed tail. */
  arrow: { from: SketchPoint; to: SketchPoint; authored: boolean };
  underline: SketchPoint[];
}

export interface StudentTap {
  x_pct: number;
  y_pct: number;
  sliceIndex?: number;
}

export interface KeyView {
  seriesInstanceUID?: string;
  sliceIndex?: number;
  ww?: number;
  wc?: number;
  zoom?: number;
  panX?: number;
  panY?: number;
}

const POINT_EPS = 0.02;
const TAP_EPS = 0.03;

export function plainTeachingText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function markVisibleOnSlice(mark: SketchMark, sliceIndex: number | null | undefined): boolean {
  if (sliceIndex == null || !Number.isFinite(sliceIndex)) return true;
  if (mark.sliceStart == null || mark.sliceEnd == null) return true;
  return sliceIndex >= mark.sliceStart && sliceIndex <= mark.sliceEnd;
}

function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function clampUnit(n: number): number {
  return Math.min(0.97, Math.max(0.03, n));
}

function point(x: number, y: number): SketchPoint {
  return { x_pct: x, y_pct: y };
}

function near(a: SketchPoint, b: SketchPoint, eps: number): boolean {
  return Math.abs(a.x_pct - b.x_pct) <= eps && Math.abs(a.y_pct - b.y_pct) <= eps;
}

function presentationTail(tip: SketchPoint): SketchPoint {
  return point(clampUnit(tip.x_pct - 0.14), clampUnit(tip.y_pct - 0.1));
}

function underlineFor(marker: SketchPoint): SketchPoint[] {
  const y = clampUnit(marker.y_pct + 0.09);
  return [
    point(clampUnit(marker.x_pct - 0.07), y),
    point(clampUnit(marker.x_pct - 0.02), clampUnit(y + 0.012)),
    point(clampUnit(marker.x_pct + 0.03), clampUnit(y - 0.008)),
    point(clampUnit(marker.x_pct + 0.08), clampUnit(y + 0.01)),
  ];
}

function sliceWindow(finding: Finding): { sliceStart?: number; sliceEnd?: number } {
  const primary = finite(finding.sliceIndex);
  const extra: number[] = [];
  for (const measurement of finding.measurements ?? []) {
    const slice = finite(measurement.sliceIndex);
    if (slice != null) extra.push(slice);
  }
  for (const event of finding.track?.events ?? []) {
    if (event.type === "annotation" && event.sliceIndex != null && Number.isFinite(event.sliceIndex)) {
      extra.push(event.sliceIndex);
    }
  }
  if (primary == null && extra.length === 0) return {};
  const center = primary ?? extra[0]!;
  const nearSlices = extra.filter((slice) => Math.abs(slice - center) <= 2);
  const all = [center, ...nearSlices];
  return { sliceStart: Math.min(...all), sliceEnd: Math.max(...all) };
}

function handlesBox(handles: Array<[number, number]>): { rx: number; ry: number } | undefined {
  if (handles.length < 2) return undefined;
  const xs = handles.map((handle) => handle[0]).filter((n) => Number.isFinite(n));
  const ys = handles.map((handle) => handle[1]).filter((n) => Number.isFinite(n));
  if (xs.length < 2 || ys.length < 2) return undefined;
  const rx = Math.max(0.02, (Math.max(...xs) - Math.min(...xs)) / 2);
  const ry = Math.max(0.02, (Math.max(...ys) - Math.min(...ys)) / 2);
  return { rx, ry };
}

function arrowFromMeasurement(
  measurement: FindingMeasurement,
  marker: SketchPoint
): { from: SketchPoint; to: SketchPoint } | undefined {
  if (measurement.handles.length < 2) return undefined;
  const a = measurement.handles[0]!;
  const b = measurement.handles[measurement.handles.length - 1]!;
  if (![a[0], a[1], b[0], b[1]].every(Number.isFinite)) return undefined;
  const da = Math.hypot(a[0] - marker.x_pct, a[1] - marker.y_pct);
  const db = Math.hypot(b[0] - marker.x_pct, b[1] - marker.y_pct);
  const tip = da <= db ? a : b;
  const tail = da <= db ? b : a;
  return { from: point(tail[0], tail[1]), to: point(tip[0], tip[1]) };
}

/** Anchor copied from the saved finding. Model JSON is not an input. */
export function buildLiveSketch(finding: Finding): LiveSketchAnchor | undefined {
  const x = finite(finding.marker?.x_pct);
  const y = finite(finding.marker?.y_pct);
  if (x == null || y == null || x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  const marker = point(x, y);
  const ellipseMeas = (finding.measurements ?? []).find((item) => item.kind === "ellipse");
  const ellipse = ellipseMeas ? handlesBox(ellipseMeas.handles) : undefined;
  const arrowMeas = (finding.measurements ?? []).find(
    (item) => item.kind === "arrow" || item.kind === "length"
  );
  let arrow = arrowMeas ? arrowFromMeasurement(arrowMeas, marker) : undefined;
  let authored = Boolean(arrow);
  if (!arrow) {
    for (const event of finding.track?.events ?? []) {
      if (event.type !== "annotation") continue;
      const isArrow = event.shape === "arrow" || event.tool === "ArrowAnnotate" || event.tool === "Length";
      if (!isArrow) continue;
      if (![event.from[0], event.from[1], event.to[0], event.to[1]].every(Number.isFinite)) continue;
      arrow = { from: point(event.from[0], event.from[1]), to: point(event.to[0], event.to[1]) };
      authored = true;
      break;
    }
  }
  const range = sliceWindow(finding);
  return {
    ...range,
    marker,
    circleRx: ellipse ? Math.max(ellipse.rx, 0.035) : 0.055,
    ...(ellipse ? { ellipse } : {}),
    arrow: {
      from: arrow?.from ?? presentationTail(marker),
      to: arrow?.to ?? marker,
      authored,
    },
    underline: underlineFor(marker),
  };
}

function anchorOf(item: LiveFinding): LiveSketchAnchor | undefined {
  if (item.sketch) return item.sketch;
  const marker = item.drive.marker;
  if (!marker) return undefined;
  return {
    sliceStart: item.drive.sliceIndex,
    sliceEnd: item.drive.sliceIndex,
    marker,
    circleRx: 0.055,
    arrow: { from: presentationTail(marker), to: marker, authored: false },
    underline: underlineFor(marker),
  };
}

function colorFor(kind: SketchMark["kind"], certainty: SketchMark["certainty"]): SketchColor {
  if (certainty === "uncertain") return "magenta";
  if (kind === "arrow" || kind === "underline") return "cyan";
  return "yellow";
}

function baseMark(
  partial: Omit<SketchMark, "color" | "delayMs" | "durationMs"> & { delayMs?: number }
): SketchMark {
  return {
    ...partial,
    color: colorFor(partial.kind, partial.certainty),
    delayMs: partial.delayMs ?? 0,
    durationMs: drawDurationMs(partial.kind === "card" ? "card" : partial.kind),
  };
}

export function uncertainTapMark(tap: StudentTap, generation = 1): SketchMark {
  const marker = point(tap.x_pct, tap.y_pct);
  return baseMark({
    id: `sk-tap-${generation}`,
    kind: "circle",
    certainty: "uncertain",
    sliceStart: tap.sliceIndex,
    sliceEnd: tap.sliceIndex,
    anchor: marker,
    rx: 0.03,
    ry: 0.03,
    caption: "uncertain",
  });
}

function sentences(text: string, max: number): string[] {
  return text
    .split(/(?<=[.!;])\s+|\n+/)
    .map((line) => plainTeachingText(line, 72))
    .filter(Boolean)
    .slice(0, max);
}

export function fillDiagramCard(
  template: DiagramTemplate,
  args: Record<string, unknown>,
  finding?: LiveFinding
): DiagramCardContent | undefined {
  const title = plainTeachingText(args.title ?? args.name, 42);
  const meaning = plainTeachingText(args.meaning, 90);
  const rawLines = Array.isArray(args.lines)
    ? args.lines
    : typeof args.lines === "string"
      ? args.lines.split(/\n+/)
      : [];
  const lines = rawLines.map((line) => plainTeachingText(line, 72)).filter(Boolean).slice(0, 4);

  if (template === "differential") {
    const authored = (finding?.mimics ?? []).map((line) => plainTeachingText(line, 72)).filter(Boolean).slice(0, 4);
    const items = lines.length ? lines : authored.length ? authored : sentences(finding?.pearl ?? "", 4);
    const heading = title || "Differential";
    if (!items.length) return undefined;
    return { template, title: heading, lines: items };
  }
  if (template === "mechanism") {
    const steps = lines.length ? lines : sentences(finding?.pearl ?? "", 4);
    const heading = title || "Mechanism";
    if (!steps.length) return undefined;
    return { template, title: heading, lines: steps };
  }
  const name = title || plainTeachingText(finding?.label, 42);
  const detail = meaning || lines[0] || sentences(finding?.whatToNotice ?? "", 1)[0] || "";
  if (!name && !detail) return undefined;
  return { template, title: name || "Sign", lines: detail ? [detail] : [] };
}

function circleMark(item: LiveFinding, anchor: LiveSketchAnchor, generation: number, delayMs: number): SketchMark {
  const ellipse = anchor.ellipse;
  return baseMark({
    id: `sk-${item.id}-${ellipse ? "ellipse" : "circle"}-${generation}`,
    kind: ellipse ? "ellipse" : "circle",
    certainty: "authored",
    findingId: item.id,
    sliceStart: anchor.sliceStart,
    sliceEnd: anchor.sliceEnd,
    anchor: anchor.marker,
    rx: ellipse?.rx ?? anchor.circleRx,
    ry: ellipse?.ry ?? anchor.circleRx,
    delayMs,
  });
}

function arrowMark(item: LiveFinding, anchor: LiveSketchAnchor, generation: number, delayMs: number): SketchMark {
  return baseMark({
    id: `sk-${item.id}-arrow-${generation}`,
    kind: "arrow",
    certainty: "authored",
    findingId: item.id,
    sliceStart: anchor.sliceStart,
    sliceEnd: anchor.sliceEnd,
    anchor: anchor.arrow.to,
    from: anchor.arrow.from,
    to: anchor.arrow.to,
    delayMs,
  });
}

function underlineMark(item: LiveFinding, anchor: LiveSketchAnchor, generation: number, delayMs: number): SketchMark {
  return baseMark({
    id: `sk-${item.id}-underline-${generation}`,
    kind: "underline",
    certainty: "authored",
    findingId: item.id,
    sliceStart: anchor.sliceStart,
    sliceEnd: anchor.sliceEnd,
    anchor: anchor.marker,
    points: anchor.underline,
    delayMs,
  });
}

function cardMark(
  item: LiveFinding | undefined,
  anchorPoint: SketchPoint,
  card: DiagramCardContent,
  generation: number,
  certainty: SketchMark["certainty"],
  slice?: { sliceStart?: number; sliceEnd?: number },
  delayMs = 420
): SketchMark {
  const id = item?.id ?? "tap";
  return baseMark({
    id: `sk-${id}-card-${card.template}-${generation}`,
    kind: "card",
    certainty,
    findingId: item?.id,
    sliceStart: slice?.sliceStart,
    sliceEnd: slice?.sliceEnd,
    anchor: anchorPoint,
    card,
    caption: certainty === "uncertain" ? "uncertain" : undefined,
    delayMs,
  });
}

/** Marks played when the tutor reaches an authored finding. */
export function replaySketches(pack: LiveTeachingPack, findingId: string, generation = 1): SketchMark[] {
  const item = pack.findings.find((finding) => finding.id === findingId);
  if (!item) return [];
  const anchor = anchorOf(item);
  if (!anchor) return [];
  const card = fillDiagramCard("sign", {}, item);
  const marks = [
    circleMark(item, anchor, generation, 0),
    arrowMark(item, anchor, generation, 160),
    underlineMark(item, anchor, generation, 280),
  ];
  if (card) marks.push(cardMark(item, anchor.marker, card, generation, "authored", anchor, 420));
  return marks;
}

export function keyViewFor(item: LiveFinding): KeyView {
  return {
    seriesInstanceUID: item.drive.seriesInstanceUID,
    sliceIndex: item.drive.sliceIndex,
    ww: item.drive.ww,
    wc: item.drive.wc,
    zoom: item.drive.zoom,
    panX: item.drive.panX,
    panY: item.drive.panY,
  };
}

export type SketchToolOutcome =
  | { ok: false; error: string }
  | { ok: true; clearOverlay: true }
  | {
      ok: true;
      findingId?: string;
      marks: SketchMark[];
      keyView?: KeyView;
      certainty: "authored" | "uncertain";
    };

const SKETCH_TOOLS = new Set(["draw_circle", "draw_arrow", "place_card", "clear_overlay", "jump_to_key_view"]);

export function isSketchTool(name: string): boolean {
  return SKETCH_TOOLS.has(name);
}

export function isSketchDraw(
  outcome: SketchToolOutcome
): outcome is Extract<SketchToolOutcome, { marks: SketchMark[] }> {
  return outcome.ok === true && !("clearOverlay" in outcome && outcome.clearOverlay);
}

function readTemplate(value: unknown): DiagramTemplate | undefined {
  return typeof value === "string" && (DIAGRAM_TEMPLATES as readonly string[]).includes(value)
    ? (value as DiagramTemplate)
    : undefined;
}

/**
 * Accept a sketch tool only at an authored anchor or the learner's tap.
 * Passing a coordinate is optional. If one is passed, it must match.
 */
export function resolveSketchTool(
  pack: LiveTeachingPack,
  name: string,
  args: Record<string, unknown>,
  ctx?: { currentFindingId?: string; studentTap?: StudentTap | null; generation?: number }
): SketchToolOutcome {
  if (name === "clear_overlay") return { ok: true, clearOverlay: true };
  if (!isSketchTool(name)) return { ok: false, error: "That tool is not part of the live teaching pack." };

  const generation = ctx?.generation ?? 1;
  const requestedId = typeof args.findingId === "string" ? args.findingId.trim() : "";
  const findingId = requestedId || (name === "jump_to_key_view" ? ctx?.currentFindingId ?? "" : "");
  const item = findingId ? pack.findings.find((finding) => finding.id === findingId) : undefined;
  const uncertain = args.uncertain === true && !item;
  const tap = ctx?.studentTap ?? null;
  const x = finite(args.x_pct);
  const y = finite(args.y_pct);

  if (name === "jump_to_key_view") {
    if (!item) return { ok: false, error: "That finding is not on this case." };
    return { ok: true, findingId: item.id, marks: [], keyView: keyViewFor(item), certainty: "authored" };
  }

  let anchorPoint: SketchPoint | undefined;
  let anchor = item ? anchorOf(item) : undefined;
  let certainty: SketchMark["certainty"] = "authored";

  if (item && anchor) {
    anchorPoint = anchor.marker;
    if ((x != null || y != null) && !near(point(x ?? anchor.marker.x_pct, y ?? anchor.marker.y_pct), anchor.marker, POINT_EPS)) {
      return { ok: false, error: "That point is not the authored marker." };
    }
  } else if (uncertain || (!item && (x != null || y != null || args.uncertain === true))) {
    if (!tap) return { ok: false, error: "The learner has not tapped the image." };
    const claimed = x != null || y != null ? point(x ?? tap.x_pct, y ?? tap.y_pct) : tap;
    if (!near(claimed, tap, TAP_EPS)) return { ok: false, error: "That point is not the learner's tap." };
    anchorPoint = point(tap.x_pct, tap.y_pct);
    certainty = "uncertain";
    anchor = {
      sliceStart: tap.sliceIndex,
      sliceEnd: tap.sliceIndex,
      marker: anchorPoint,
      circleRx: 0.04,
      arrow: { from: presentationTail(anchorPoint), to: anchorPoint, authored: false },
      underline: underlineFor(anchorPoint),
    };
  } else if (!item) {
    return { ok: false, error: "Pass an authored finding id, or uncertain:true after the learner taps." };
  } else {
    return { ok: false, error: "No authored marker to draw on." };
  }

  if (!anchor || !anchorPoint) return { ok: false, error: "No authored marker to draw on." };

  const slice = { sliceStart: anchor.sliceStart, sliceEnd: anchor.sliceEnd };
  const keyView = item ? { sliceIndex: item.drive.sliceIndex, seriesInstanceUID: item.drive.seriesInstanceUID } : { sliceIndex: tap?.sliceIndex };

  if (name === "draw_circle") {
    const mark = item
      ? circleMark(item, anchor, generation, 0)
      : baseMark({
          id: `sk-tap-circle-${generation}`,
          kind: "circle",
          certainty,
          sliceStart: slice.sliceStart,
          sliceEnd: slice.sliceEnd,
          anchor: anchorPoint,
          rx: anchor.circleRx,
          ry: anchor.circleRx,
          caption: "uncertain",
        });
    return { ok: true, findingId: item?.id, marks: [mark], keyView, certainty };
  }

  if (name === "draw_arrow") {
    const mark = item
      ? arrowMark(item, anchor, generation, 0)
      : baseMark({
          id: `sk-tap-arrow-${generation}`,
          kind: "arrow",
          certainty,
          sliceStart: slice.sliceStart,
          sliceEnd: slice.sliceEnd,
          anchor: anchor.arrow.to,
          from: anchor.arrow.from,
          to: anchor.arrow.to,
          caption: "uncertain",
        });
    return { ok: true, findingId: item?.id, marks: [mark], keyView, certainty };
  }

  if (name === "place_card") {
    const template = readTemplate(args.template);
    if (!template) return { ok: false, error: "template must be differential, mechanism, or sign." };
    const card = fillDiagramCard(template, args, item);
    if (!card) return { ok: false, error: "That card has no text to show." };
    return {
      ok: true,
      findingId: item?.id,
      marks: [cardMark(item, anchorPoint, card, generation, certainty, slice, 0)],
      keyView,
      certainty,
    };
  }

  return { ok: false, error: "That tool is not part of the live teaching pack." };
}
