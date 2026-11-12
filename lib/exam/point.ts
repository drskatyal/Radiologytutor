import type { RenderConfirmedViewer } from '../viewerController';
import { matchesView } from '../journal/match';
import type { ExamPoint } from './types';
/** Learner input uses the image that is actually displayed, including multiframe identity. */
export function captureExamPoint(viewer: Partial<RenderConfirmedViewer> | null, x: number, y: number): ExamPoint {
  const evidence = viewer?.captureImagePoint?.(x, y), rendered = viewer?.getRenderedView?.();
  if (!evidence || !rendered || evidence.snapshot.renderSeq !== rendered.snapshot.renderSeq || !matchesView(evidence.snapshot, rendered.snapshot)) throw new Error('Wait for the image to render before selecting a point.');
  if (![rendered.snapshot.studyUID, rendered.snapshot.seriesUID, rendered.snapshot.sopUID].every(Boolean) || !Number.isInteger(rendered.snapshot.frame) || rendered.snapshot.frame < 1) throw new Error('The displayed image has no complete identity.');
  if (/mpr|volume/i.test(evidence.snapshot.layout)) throw new Error('Select a point on the original stack image.');
  const p = evidence.imagePoint, [columns, rows] = evidence.dimensions;
  if (![columns, rows].every(n => Number.isInteger(n) && n > 0) || ![p.x, p.y].every(Number.isFinite) || p.x < 0 || p.y < 0 || p.x > columns - 1 || p.y > rows - 1) throw new Error('Select a point inside the image.');
  return { sopUID: evidence.snapshot.sopUID, frame: evidence.snapshot.frame, imagePoint: { ...p } };
}
