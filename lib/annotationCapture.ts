/**
 * Pure helpers for turning a Cornerstone measurement into a record event.
 * The viewer supplies normalized handles (it owns world↔canvas); everything
 * else — tool name, shape, stats — is decided here so tests don't need WebGL.
 */

import type { MarkerShape, RecordedAnnotation, ViewerEvent } from "./types";

export function shapeForAnnotationTool(tool?: string): MarkerShape {
  switch (tool) {
    case "ArrowAnnotate":
    case "Length":
    case "Angle":
    case "Bidirectional":
      return "arrow";
    default:
      return "circle";
  }
}

function finite(n: number | undefined): number | undefined {
  return n != null && Number.isFinite(n) ? n : undefined;
}

/** Build the viewer event the recorder stamps, or null when there is no handle. */
export function annotationViewerEvent(input: {
  tool?: string;
  handles: Array<[number, number]>;
  sliceIndex?: number;
  annotationUID?: string;
  label?: string;
  lengthMm?: number;
  meanHu?: number;
  maxHu?: number;
  minHu?: number;
  stdHu?: number;
  areaMm2?: number;
  unit?: string;
}): Extract<ViewerEvent, { type: "annotation" }> | null {
  const handles = input.handles.filter(
    (p) =>
      Array.isArray(p) &&
      p.length >= 2 &&
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1])
  );
  if (!handles.length) return null;
  const from = handles[0];
  const to = handles[handles.length - 1] ?? handles[0];
  const event: Extract<ViewerEvent, { type: "annotation" }> = {
    type: "annotation",
    shape: shapeForAnnotationTool(input.tool),
    from,
    to,
    handles,
  };
  if (input.tool) event.tool = input.tool;
  if (input.sliceIndex != null && Number.isFinite(input.sliceIndex)) {
    event.sliceIndex = input.sliceIndex;
  }
  if (input.annotationUID) event.annotationUID = input.annotationUID;
  if (input.label) event.label = input.label;
  const lengthMm = finite(input.lengthMm);
  const meanHu = finite(input.meanHu);
  const maxHu = finite(input.maxHu);
  const minHu = finite(input.minHu);
  const stdHu = finite(input.stdHu);
  const areaMm2 = finite(input.areaMm2);
  if (lengthMm != null) event.lengthMm = lengthMm;
  if (meanHu != null) event.meanHu = meanHu;
  if (maxHu != null) event.maxHu = maxHu;
  if (minHu != null) event.minHu = minHu;
  if (stdHu != null) event.stdHu = stdHu;
  if (areaMm2 != null) event.areaMm2 = areaMm2;
  if (input.unit) event.unit = input.unit;
  return event;
}

/** Same gesture (COMPLETED then a trailing MODIFIED) — don't double-record. */
export function sameAnnotationStroke(
  a: Pick<RecordedAnnotation, "annotationUID" | "handles" | "from" | "to">,
  b: Pick<RecordedAnnotation, "annotationUID" | "handles" | "from" | "to">
): boolean {
  if (a.annotationUID && b.annotationUID && a.annotationUID !== b.annotationUID) {
    return false;
  }
  const ah = a.handles?.length ? a.handles : [a.from, a.to];
  const bh = b.handles?.length ? b.handles : [b.from, b.to];
  if (ah.length !== bh.length) return false;
  const eps = 0.004;
  for (let i = 0; i < ah.length; i++) {
    if (Math.abs(ah[i][0] - bh[i][0]) > eps) return false;
    if (Math.abs(ah[i][1] - bh[i][1]) > eps) return false;
  }
  return true;
}
