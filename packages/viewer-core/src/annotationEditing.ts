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
