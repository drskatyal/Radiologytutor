import { resolveAnchor } from "../anchors/resolve";
import { measuredLength } from "../anchors/geometry";
import type { JournalEntry, ViewerSnapshot } from "../journal/types";
import { ReplayError, type ReplayShape, type ProjectedReplayShape } from "./types";
export const sameImage = (a: ViewerSnapshot, b: ViewerSnapshot) => a.studyUID === b.studyUID && a.seriesUID === b.seriesUID && a.sopUID === b.sopUID && a.frame === b.frame;
export function replayShape(entry: JournalEntry, prefix: JournalEntry[]): ReplayShape | null {
  if (!["marker", "annotation"].includes(entry.kind)) return null;
  const id = entry.kind === "marker" ? entry.payload?.markerId : entry.payload?.annotationId;
  if (typeof id !== "string" || !id) throw new ReplayError("geometry", "Annotation identity is missing.", entry.seq);
  if (["remove", "undo"].includes(String(entry.payload?.action))) return null;
  const anchor = resolveAnchor(id, prefix);
  if (anchor.anchorStatus !== "resolved" || !anchor.snapshot || !anchor.dimensions || !anchor.imagePoint) throw new ReplayError("geometry", "Annotation has no confirmed image-pixel geometry.", entry.seq);
  const event = entry.payload?.event as { tool?: string; label?: string } | undefined;
  if (event?.label !== undefined && (typeof event.label !== "string" || event.label.length > 1000)) throw new ReplayError("geometry", "Invalid annotation label.", entry.seq);
  const tool = entry.kind === "marker" ? "marker" : event?.tool ?? "";
  if (!["marker", "Length", "EllipticalROI", "RectangleROI", "Probe", "Bidirectional", "ArrowAnnotate", "Angle"].includes(tool)) throw new ReplayError("geometry", "The recorded annotation tool is unsupported.", entry.seq);
  const points = anchor.imagePoints ?? [anchor.imagePoint];
  const required: Record<string, number> = { marker: 1, Probe: 1, Length: 2, ArrowAnnotate: 2, Angle: 3, Bidirectional: 4, RectangleROI: 4, EllipticalROI: 4 };
  if (points.length !== required[tool]) throw new ReplayError("geometry", "The recorded annotation handles are incomplete.", entry.seq);
  return { id, kind: entry.kind as "marker" | "annotation", tool, label: event?.label ?? "", snapshot: anchor.snapshot, dimensions: anchor.dimensions, imagePoints: points,
    patientPoints: anchor.patientPoints ?? [anchor.patientPoint], geometry: anchor.geometry, lengthMm: ["Length", "Bidirectional"].includes(tool) ? measuredLength(points.slice(0, 2), anchor.geometry) : null };
}
/** Project original pixels through the displayed image; never through a guessed index. */
export function projectReplayShapes(shapes: ReplayShape[], shown: ViewerSnapshot, dimensions: number[], project: (x: number, y: number) => { x: number; y: number } | null): ProjectedReplayShape[] {
  return shapes.filter(s => sameImage(s.snapshot, shown)).map(shape => {
    if (shape.dimensions.some((n, i) => n !== dimensions[i])) throw new ReplayError("geometry", "Recorded image dimensions changed.");
    const canvasPoints = shape.imagePoints.map(point => {
      const p = project(point.x / (dimensions[0] - 1), point.y / (dimensions[1] - 1));
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new ReplayError("geometry", "The annotation could not be projected onto the confirmed image.");
      return p;
    });
    return { ...shape, canvasPoints };
  });
}
