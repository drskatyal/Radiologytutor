import type { RecordedAnnotation } from "../types";

/** One-based frame identity. A stack index is only an address in one inventory order. */
export type ToolFrame = { studyUID: string; seriesUID: string; sopUID: string; frame: number };
export type ApprovedToolAnchor = {
  id: string; findingId: string; target: ToolFrame;
  point?: { x: number; y: number; space?: "image" | "viewport" };
};
export type ApprovedToolAnnotation = {
  id: string; anchorId: string; annotation: RecordedAnnotation;
};
/** Built on the server from current approvals and DICOM metadata, never request JSON. */
export type ApprovedToolContext = {
  series: { studyUID: string; seriesUID: string; frameCount: number; frames: ToolFrame[] }[];
  anchors: ApprovedToolAnchor[];
  annotations: ApprovedToolAnnotation[];
};
export type ApprovedToolAction = {
  type: "point_to" | "draw_annotation" | "scroll_to" | "set_series";
  anchorId: string;
  annotationId?: string;
  findingId: string;
  seriesInstanceUID: string;
  sliceIndex: number;
  target: ToolFrame;
  point?: { x: number; y: number; space?: "image" | "viewport" };
  annotation?: RecordedAnnotation;
  ww?: number; wc?: number;
};
export const emptyToolContext = (): ApprovedToolContext => ({ series: [], anchors: [], annotations: [] });
export function sameToolFrame(a: ToolFrame, b: ToolFrame): boolean {
  return a.studyUID === b.studyUID && a.seriesUID === b.seriesUID && a.sopUID === b.sopUID && a.frame === b.frame;
}
export function isProtectedTool(name: string, args: Record<string, unknown>): boolean {
  return ["point_to", "draw_annotation", "scroll_to"].includes(name) ||
    (name === "set_series" && ("sliceIndex" in args || "anchorId" in args));
}
const unit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const only = (args: Record<string, unknown>, keys: string[]) => Object.keys(args).every(k => keys.includes(k));

/** Strict model boundary: no coordinate tolerance, numeric coercion, rounding or index fallback. */
export function resolveApprovedTool(name: string, args: Record<string, unknown>, context?: ApprovedToolContext): ApprovedToolAction | null {
  if (!context || !args || typeof args !== "object" || Array.isArray(args)) return null;
  let anchor: ApprovedToolAnchor | undefined;
  let annotation: ApprovedToolAnnotation | undefined;
  if (name === "point_to") {
    if (!only(args, ["anchorId"]) || typeof args.anchorId !== "string") return null;
    anchor = context.anchors.find(a => a.id === args.anchorId);
    if (!anchor?.point || !unit(anchor.point.x) || !unit(anchor.point.y)) return null;
  } else if (name === "draw_annotation") {
    if (!only(args, ["annotationId"]) || typeof args.annotationId !== "string") return null;
    annotation = context.annotations.find(a => a.id === args.annotationId);
    anchor = context.anchors.find(a => a.id === annotation?.anchorId);
    if (!annotation || !anchor) return null;
  } else if (name === "scroll_to" || name === "set_series") {
    const keys = ["anchorId", "sliceIndex", "seriesInstanceUID", "findingId", ...(name === "set_series" ? ["ww", "wc"] : [])];
    if (!only(args, keys)) return null;
    if (args.anchorId !== undefined) {
      if (typeof args.anchorId !== "string" || args.sliceIndex !== undefined) return null;
      anchor = context.anchors.find(a => a.id === args.anchorId);
    } else {
      if (typeof args.sliceIndex !== "number" || !Number.isInteger(args.sliceIndex) || args.sliceIndex < 0) return null;
      // An omitted series is unambiguous only with a named approved finding or a single series.
      const seriesUID = args.seriesInstanceUID ?? (typeof args.findingId === "string" ? context.anchors.find(a => a.findingId === args.findingId)?.target.seriesUID : context.series.length === 1 ? context.series[0].seriesUID : undefined);
      const series = context.series.find(s => s.seriesUID === seriesUID);
      if (!series || series.frameCount !== series.frames.length || args.sliceIndex >= series.frameCount) return null;
      const target = series.frames[args.sliceIndex];
      anchor = context.anchors.find(a => sameToolFrame(a.target, target) && (args.findingId === undefined || a.findingId === args.findingId));
    }
    if (!anchor || (args.seriesInstanceUID !== undefined && args.seriesInstanceUID !== anchor.target.seriesUID) || (args.findingId !== undefined && args.findingId !== anchor.findingId)) return null;
    if (name === "set_series" && ((args.ww !== undefined || args.wc !== undefined) && !(typeof args.ww === "number" && Number.isFinite(args.ww) && args.ww > 0 && typeof args.wc === "number" && Number.isFinite(args.wc)))) return null;
  } else return null;
  if (!anchor) return null;
  const series = context.series.find(s => s.seriesUID === anchor.target.seriesUID && s.studyUID === anchor.target.studyUID);
  if (!series || !Number.isInteger(series.frameCount) || series.frameCount !== series.frames.length) return null;
  const matches = series.frames.flatMap((f, i) => sameToolFrame(f, anchor!.target) ? [i] : []);
  if (matches.length !== 1) return null;
  return {
    type: name as ApprovedToolAction["type"], anchorId: anchor.id, findingId: anchor.findingId,
    seriesInstanceUID: anchor.target.seriesUID, sliceIndex: matches[0], target: anchor.target,
    ...(name === "point_to" ? { point: anchor.point } : {}),
    ...(annotation ? { annotationId: annotation.id, annotation: annotation.annotation } : {}),
    ...(name === "set_series" && args.ww !== undefined ? { ww: args.ww as number, wc: args.wc as number } : {}),
  };
}

/** The model gets IDs and addresses, never authority to provide geometry. */
export function approvedToolsPrompt(context?: ApprovedToolContext): string {
  return `Approved viewer tools: copy anchorId for point_to or scroll_to; copy annotationId for draw_annotation. Never supply coordinates. Numeric scroll indices refer ONLY to this server inventory; the viewer resolves the returned SOP/frame in its own stack. Missing IDs mean the tool is unavailable.\n${JSON.stringify(context ? {
    series: context.series.map(s => ({ seriesInstanceUID: s.seriesUID, frameCount: s.frameCount })),
    anchors: context.anchors.map(a => ({ anchorId: a.id, findingId: a.findingId, ...a.target, sliceIndex: context.series.find(s => s.seriesUID === a.target.seriesUID && s.studyUID === a.target.studyUID)?.frames.findIndex(f => sameToolFrame(f, a.target)) })),
    annotations: context.annotations.map(a => ({ annotationId: a.id, anchorId: a.anchorId })),
  } : emptyToolContext())}`;
}

/** Read the CURRENT stack, not a rail count or a progressive archive offset. */
export function toolFrameFromImageId(id: string): ToolFrame | null {
  const m = /\/studies\/([^/?#]+)\/series\/([^/?#]+)\/instances\/([^/?#]+)\/frames\/([1-9]\d*)(?:[?#]|$)/.exec(id);
  if (!m) return null;
  try { return { studyUID: decodeURIComponent(m[1]), seriesUID: decodeURIComponent(m[2]), sopUID: decodeURIComponent(m[3]), frame: Number(m[4]) }; } catch { return null; }
}
export function approvedStackIndex(target: ToolFrame, imageIds: readonly string[]): number | null {
  const matches = imageIds.flatMap((id, i) => { const frame = toolFrameFromImageId(id); return frame && sameToolFrame(frame, target) ? [i] : []; });
  return matches.length === 1 ? matches[0] : null;
}
