import type { RecordedEvent } from "../types";
import { approvedStackIndex, sameToolFrame, toolFrameFromImageId, type ApprovedToolAction } from "./approvedTools";

export interface ApprovedToolViewer {
  activeSeriesUID?: string;
  seriesUIDs: string[];
  getToolImageIds?: () => readonly string[];
  getToolImageId?: () => string | undefined;
  projectToolPoint?: (x: number, y: number) => { x: number; y: number } | null;
  showSeries(uid: string): void;
  settle(): Promise<void>;
  showState(state: { sliceIndex: number; windowWidth?: number; windowCenter?: number }, duration?: number): Promise<void>;
  applyEvent(event: RecordedEvent): void;
}
/** Fresh server authorization is required by the caller. This checks loaded identity, not render acknowledgement (M9). */
export async function executeApprovedTool(action: ApprovedToolAction, viewer: ApprovedToolViewer, point: (x: number, y: number) => Promise<void>): Promise<boolean> {
  if (!viewer.getToolImageIds || !viewer.getToolImageId || !viewer.seriesUIDs.includes(action.target.seriesUID)) return false;
  if (viewer.activeSeriesUID !== action.target.seriesUID) { viewer.showSeries(action.target.seriesUID); await viewer.settle(); }
  if (viewer.activeSeriesUID !== action.target.seriesUID) return false;
  const index = approvedStackIndex(action.target, viewer.getToolImageIds());
  if (index === null) return false;
  // Use the loaded stack's SOP/frame index, NEVER the server's archive offset.
  await viewer.showState({ sliceIndex: index, ...(action.ww !== undefined ? { windowWidth: action.ww, windowCenter: action.wc } : {}) }, 520);
  await viewer.settle();
  const current = toolFrameFromImageId(viewer.getToolImageId() ?? "");
  if (!current || !sameToolFrame(current, action.target) || approvedStackIndex(action.target, viewer.getToolImageIds()) === null) return false;
  if (action.type === "point_to") {
    if (!action.point) return false;
    const projected = action.point.space === "image" ? viewer.projectToolPoint?.(action.point.x, action.point.y) : action.point;
    if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.x < 0 || projected.x > 1 || projected.y < 0 || projected.y > 1) return false;
    await point(projected.x, projected.y);
  } else if (action.type === "draw_annotation") {
    if (!action.annotation) return false;
    viewer.applyEvent({ ...action.annotation, t: 0, type: "annotation", sliceIndex: index });
    await viewer.settle();
  }
  return true;
}
