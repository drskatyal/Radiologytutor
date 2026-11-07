/**
 * Annotation editing shared by the desktop viewer and the web viewer: select,
 * delete (one, all on the image, all in the series), erase, undo / redo, copy
 * a measurement's value, and an OPTIONAL arrow label edited inline.
 *
 * Cornerstone already keeps an undo history for drawing and moving
 * annotations (HistoryMemo). Deletions here push the matching "deleting" memo
 * first, so one Ctrl+Z / Ctrl+Y history covers draw, move, label, delete and
 * delete-all (a delete-all is one grouped step).
 *
 * Pure of app code: the caller passes the Cornerstone core / tools modules.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Cornerstone modules are passed in untyped. */

export interface AnnotationLike {
  annotationUID?: string;
  isSelected?: boolean;
  metadata?: { toolName?: string; referencedImageId?: string; FrameOfReferenceUID?: string };
  data?: {
    label?: string;
    text?: string;
    handles?: { points?: number[][] };
    cachedStats?: Record<string, Record<string, unknown>>;
  };
}

/** Tools whose annotations can be selected, erased and deleted. */
export const EDITABLE_TOOLS = [
  "Length",
  "Angle",
  "CobbAngle",
  "EllipticalROI",
  "RectangleROI",
  "CircleROI",
  "PlanarFreehandROI",
  "Probe",
  "ArrowAnnotate",
  "Bidirectional",
] as const;

/**
 * Arrow drawn with no prompt: Cornerstone deletes an arrow whose new label is
 * empty, so the arrow is created with this placeholder and the completion
 * listener (installAnnotationEditing) blanks it before it is ever drawn.
 */
export const PENDING_LABEL = "​";

export interface LabelEditRequest {
  annotation: AnnotationLike;
  element: HTMLElement;
  /** Where to put the inline field, in the element's CSS pixels. */
  at: { x: number; y: number };
  current: string;
  /** Save (any text, empty is fine). */
  done: (label: string) => void;
}

/**
 * ArrowAnnotate configuration: draw without asking; double-click asks the
 * caller's inline editor (never `window.prompt`).
 */
export function arrowLabelConfig(onEdit: (req: LabelEditRequest) => void) {
  return {
    getTextCallback: (done: (text: string) => void) => done(PENDING_LABEL),
    changeTextCallback: (annotation: AnnotationLike, detail: { element: HTMLElement; currentPoints?: { canvas?: number[] } }, done: (text: string) => void) => {
      const point = detail.currentPoints?.canvas ?? [0, 0];
      onEdit({
        annotation,
        element: detail.element,
        at: { x: point[0], y: point[1] },
        current: cleanLabel(annotation.data?.label),
        done,
      });
    },
  };
}

// Label edits requested by Cornerstone's arrow tool (one configuration per
// engine) reach the editor registered for that viewport element.
const editors = new Map<HTMLElement, (req: LabelEditRequest) => void>();

export function registerLabelEditor(element: HTMLElement, open: (req: LabelEditRequest) => void): () => void {
  editors.set(element, open);
  return () => {
    if (editors.get(element) === open) editors.delete(element);
  };
}

/** Pass to the ArrowAnnotate tool configuration: no prompt, inline editing. */
export const arrowAnnotateConfig = arrowLabelConfig((req) => {
  for (const [element, open] of editors) {
    if (element === req.element || element.contains(req.element) || req.element.contains(element)) return open(req);
  }
  req.done(req.current);
});

export function cleanLabel(label: string | undefined): string {
  return (label ?? "").replace(/​/g, "");
}

const fmt = (v: unknown, digits = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : null);

/** A measurement as text for the clipboard: "Length 23.4 mm", "Mean 41.2 HU · SD 9.8 · Area 120.5 mm²". */
export function describeAnnotation(a: AnnotationLike): string {
  const tool = a.metadata?.toolName ?? "Annotation";
  const stats = Object.values(a.data?.cachedStats ?? {})[0] ?? {};
  const unit = (key: string, fallback: string) => {
    const u = stats[key];
    return typeof u === "string" && u ? u : fallback;
  };
  const parts: string[] = [];
  const label = cleanLabel(a.data?.label || a.data?.text);
  if (fmt(stats.length) != null) parts.push(`Length ${fmt(stats.length)} ${unit("unit", "mm")}`);
  if (fmt(stats.width) != null && fmt(stats.length) != null && tool === "Bidirectional") parts.push(`Width ${fmt(stats.width)} ${unit("unit", "mm")}`);
  if (fmt(stats.angle) != null) parts.push(`Angle ${fmt(stats.angle)}°`);
  if (fmt(stats.mean) != null) parts.push(`Mean ${fmt(stats.mean)} ${unit("modalityUnit", "")}`.trim());
  if (fmt(stats.stdDev) != null) parts.push(`SD ${fmt(stats.stdDev)}`);
  if (fmt(stats.max) != null && tool !== "Probe") parts.push(`Max ${fmt(stats.max)}`);
  if (fmt(stats.area) != null) parts.push(`Area ${fmt(stats.area)} ${unit("areaUnit", "mm²")}`);
  if (tool === "Probe" && fmt(stats.value) != null) parts.push(`Value ${fmt(stats.value)} ${unit("modalityUnit", "")}`.trim());
  if (label) parts.push(label);
  const name = tool.replace(/ROI$/, " ROI").replace(/([a-z])([A-Z])/g, "$1 $2");
  return parts.length ? parts.join(" · ") : name;
}

/** Annotations on one image (stack viewports reference an imageId). */
export function onImage(all: readonly AnnotationLike[], imageId: string | undefined): AnnotationLike[] {
  if (!imageId) return [];
  return all.filter((a) => a.metadata?.referencedImageId === imageId && isEditable(a));
}

/** Annotations on any image of a series. */
export function inSeries(all: readonly AnnotationLike[], imageIds: readonly string[]): AnnotationLike[] {
  const set = new Set(imageIds);
  return all.filter((a) => a.metadata?.referencedImageId != null && set.has(a.metadata.referencedImageId) && isEditable(a));
}

export function isEditable(a: AnnotationLike): boolean {
  return (EDITABLE_TOOLS as readonly string[]).includes(a.metadata?.toolName ?? "");
}

export interface EditingContext {
  core: any;
  tools: any;
  /** The viewport's element (what Cornerstone enabled). */
  element: HTMLElement;
  /** The viewport's tool group id. */
  toolGroupId: string;
}

function history(core: any) {
  return core.utilities.HistoryMemo.DefaultHistoryMemo as {
    undo(): void;
    redo(): void;
    canUndo: boolean;
    canRedo: boolean;
    startGroupRecording(): void;
    endGroupRecording(): void;
  };
}

function viewportOf(ctx: EditingContext): any {
  return ctx.core.getEnabledElement(ctx.element)?.viewport ?? null;
}

function render(ctx: EditingContext) {
  viewportOf(ctx)?.render();
}

/** The image the viewport shows now. */
export function currentImageId(ctx: EditingContext): string | undefined {
  const vp = viewportOf(ctx);
  return vp?.getCurrentImageId?.() ?? undefined;
}

export function allAnnotations(ctx: EditingContext): AnnotationLike[] {
  return (ctx.tools.annotation.state.getAllAnnotations() ?? []) as AnnotationLike[];
}

/** The topmost editable annotation under a canvas point on the current image. */
export function annotationAt(ctx: EditingContext, canvas: [number, number], proximity = 6): AnnotationLike | null {
  const group = ctx.tools.ToolGroupManager.getToolGroup(ctx.toolGroupId);
  const here = onImage(allAnnotations(ctx), currentImageId(ctx));
  for (let i = here.length - 1; i >= 0; i -= 1) {
    const a = here[i];
    const tool = group?.getToolInstance(a.metadata!.toolName!);
    try {
      if (tool?.isPointNearTool?.(ctx.element, a, canvas, proximity)) return a;
    } catch {
      // A tool without stats yet (still drawing) can throw; skip it.
    }
  }
  return null;
}

export function selected(ctx: EditingContext): AnnotationLike[] {
  // Cornerstone returns selected annotation UIDs.
  const uids = new Set((ctx.tools.annotation.selection.getAnnotationsSelected() ?? []) as string[]);
  return allAnnotations(ctx).filter((a) => a.annotationUID && uids.has(a.annotationUID) && isEditable(a));
}

export function select(ctx: EditingContext, a: AnnotationLike | null): void {
  const sel = ctx.tools.annotation.selection;
  if (!a?.annotationUID) sel.deselectAnnotation();
  else sel.setAnnotationSelected(a.annotationUID, true, false);
  render(ctx);
}

/** Delete with undo: one step for one annotation, one grouped step for many. */
export function remove(ctx: EditingContext, annotations: readonly AnnotationLike[]): number {
  const list = annotations.filter((a) => a.annotationUID);
  if (!list.length) return 0;
  const memo = history(ctx.core);
  const grouped = list.length > 1;
  if (grouped) memo.startGroupRecording();
  try {
    for (const a of list) {
      ctx.tools.AnnotationTool.createAnnotationMemo(ctx.element, a, { deleting: true });
      ctx.tools.annotation.selection.deselectAnnotation(a.annotationUID);
      ctx.tools.annotation.state.removeAnnotation(a.annotationUID);
    }
  } finally {
    if (grouped) memo.endGroupRecording();
  }
  render(ctx);
  return list.length;
}

export function undo(ctx: EditingContext): boolean {
  const memo = history(ctx.core);
  if (!memo.canUndo) return false;
  memo.undo();
  render(ctx);
  return true;
}

export function redo(ctx: EditingContext): boolean {
  const memo = history(ctx.core);
  if (!memo.canRedo) return false;
  memo.redo();
  render(ctx);
  return true;
}

export function canUndo(core: any): boolean {
  return !!history(core).canUndo;
}
export function canRedo(core: any): boolean {
  return !!history(core).canRedo;
}

/** Set an annotation's label (empty removes the text box) with undo. */
export function setLabel(ctx: EditingContext, a: AnnotationLike, label: string): void {
  if (!a.data) return;
  ctx.tools.AnnotationTool.createAnnotationMemo(ctx.element, a, {});
  a.data.label = label;
  if ("text" in a.data) a.data.text = label;
  render(ctx);
}

/** Handle points of an annotation in the element's canvas pixels (for the selection overlay). */
export function handlesOnCanvas(ctx: EditingContext, a: AnnotationLike): [number, number][] {
  const vp = viewportOf(ctx);
  const points = a.data?.handles?.points ?? [];
  if (!vp) return [];
  return points.map((p) => vp.worldToCanvas(p) as [number, number]);
}

/** Where the label's text box sits on the canvas, if the reader dragged it somewhere (else Cornerstone places it). */
export function movedLabelOnCanvas(ctx: EditingContext, a: AnnotationLike): [number, number] | null {
  const box = (a.data?.handles as { textBox?: { hasMoved?: boolean; worldPosition?: number[] } } | undefined)?.textBox;
  const vp = viewportOf(ctx);
  if (!vp || !box?.hasMoved || !box.worldPosition) return null;
  return vp.worldToCanvas(box.worldPosition) as [number, number];
}

type Pt = readonly [number, number];
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Does the segment a–b cross (or lie in) the box? Liang–Barsky clipping. */
function segmentHitsBox(a: Pt, b: Pt, r: Box): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a[0] - r.left],
    [dx, r.left + r.width - a[0]],
    [-dy, a[1] - r.top],
    [dy, r.top + r.height - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Top-left of the inline label field (`size`: the field plus its hint) for an
 * arrow drawn through `points` (canvas pixels, arrowhead first), inside
 * `bounds`. It goes where the label will be drawn, clear of the arrow so the
 * line never runs through the text: a moved label's own spot first, then
 * Cornerstone's default (right of the rightmost point, centred on the arrow),
 * left of it, above, below. The first spot that fits on screen without
 * touching the arrow wins; if none does, the first one, kept on screen.
 */
export function labelEditorPosition(
  points: readonly Pt[],
  size: { width: number; height: number },
  bounds: { width: number; height: number },
  movedLabel?: Pt | null,
  gap = 12,
): { left: number; top: number } {
  const margin = 4;
  const clamp = (left: number, top: number) => ({
    left: Math.round(Math.max(margin, Math.min(left, bounds.width - size.width - margin))),
    top: Math.round(Math.max(margin, Math.min(top, bounds.height - size.height - margin))),
  });
  if (!points.length) return clamp(movedLabel?.[0] ?? margin, movedLabel?.[1] ?? margin);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const candidates = [
    ...(movedLabel ? [[movedLabel[0], movedLabel[1] - size.height / 2]] : []),
    [maxX + gap, midY - size.height / 2],
    [minX - gap - size.width, midY - size.height / 2],
    [midX - size.width / 2, minY - gap - size.height],
    [midX - size.width / 2, maxY + gap],
  ].map(([l, t]) => clamp(l, t));
  // Clear of the arrow by a few pixels (the arrowhead and the handles are wider than the line).
  const pad = 6;
  const clear = (c: { left: number; top: number }) => {
    const r = { left: c.left - pad, top: c.top - pad, width: size.width + 2 * pad, height: size.height + 2 * pad };
    for (let i = 1; i < points.length; i += 1) if (segmentHitsBox(points[i - 1], points[i], r)) return false;
    return points.length > 1 || !segmentHitsBox(points[0], points[0], r);
  };
  return candidates.find(clear) ?? candidates[0];
}

/**
 * A freehand ROI that closed with no stats. Cornerstone's contour render
 * clears `invalidated` on every frame, including the frames drawn while the
 * contour is still the active one (when stats are skipped), so the finished
 * contour can end with an empty stats map and never show its area / mean /
 * HU. The viewer flags it again on the frame after completion and re-renders.
 */
export function needsFreehandStats(a: AnnotationLike & { data?: { contour?: { closed?: boolean } } }): boolean {
  if (a.metadata?.toolName !== "PlanarFreehandROI" || !a.data?.contour?.closed) return false;
  const stats = a.data.cachedStats;
  return !stats || Object.keys(stats).length === 0;
}

/**
 * Wire the arrow placeholder clean-up and a change notifier (selection,
 * add, remove, modify, undo). Returns the uninstaller.
 */
export function installAnnotationEditing(core: any, tools: any, onChange: () => void): () => void {
  const E = tools.Enums.Events;
  // The arrow tool sets its label after "completed" too (a LabelChange
  // "modified"), so the placeholder is blanked on both.
  const blank = (evt: any) => {
    const a = evt.detail?.annotation as AnnotationLike | undefined;
    if (a?.data && a.data.label === PENDING_LABEL) a.data.label = "";
    onChange();
  };
  const withBlank = [E.ANNOTATION_COMPLETED, E.ANNOTATION_MODIFIED].filter(Boolean);
  const plain = [E.ANNOTATION_SELECTION_CHANGE, E.ANNOTATION_REMOVED, E.ANNOTATION_ADDED].filter(Boolean);
  for (const e of withBlank) core.eventTarget.addEventListener(e, blank);
  for (const e of plain) core.eventTarget.addEventListener(e, onChange);
  return () => {
    for (const e of withBlank) core.eventTarget.removeEventListener(e, blank);
    for (const e of plain) core.eventTarget.removeEventListener(e, onChange);
  };
}
