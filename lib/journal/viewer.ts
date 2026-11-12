import { voiToWwWc } from "@flowrad/viewer-core/viewportVoi";
import { toolFrameFromImageId } from "../harness/approvedTools";
import type { ViewerSnapshot } from "./types";

export interface SnapshotViewport {
  getCurrentImageId?: () => string;
  getProperties(): { voiRange?: { lower: number; upper: number }; invert?: boolean };
  getZoom(): number;
  getPan(): [number, number];
  getCamera?: () => { viewPlaneNormal?: number[]; viewUp?: number[]; flipHorizontal?: boolean; flipVertical?: boolean };
  getViewPresentation?: () => { rotation?: number };
}

/** Called only in IMAGE_RENDERED, never from a requested slice or camera event. */
export function displayedSnapshot(vp: SnapshotViewport, viewportId: string, layout: string, renderSeq: number): ViewerSnapshot | null {
  const identity = toolFrameFromImageId(vp.getCurrentImageId?.() ?? "");
  const props = vp.getProperties();
  const camera = vp.getCamera?.();
  const voi = voiToWwWc(props.voiRange);
  if (!identity || !voi || !camera?.viewPlaneNormal || !camera.viewUp) return null;
  const snapshot: ViewerSnapshot = {
    ...identity, viewportId, layout, renderSeq,
    voi,
    invert: !!props.invert,
    camera: { zoom: vp.getZoom(), pan: [...vp.getPan()], rotation: vp.getViewPresentation?.().rotation ?? 0, flipH: !!camera.flipHorizontal, flipV: !!camera.flipVertical },
    orientation: { normal: Array.from(camera.viewPlaneNormal), up: Array.from(camera.viewUp) },
  };
  return validSnapshot(snapshot) ? snapshot : null;
}

export function validSnapshot(s: ViewerSnapshot): boolean {
  return !!s && [s.studyUID, s.seriesUID, s.sopUID].every(v => typeof v === "string" && /^\d+(\.\d+)+$/.test(v)) &&
    Number.isInteger(s.frame) && s.frame > 0 && typeof s.viewportId === "string" && typeof s.layout === "string" &&
    Number.isInteger(s.renderSeq) && s.renderSeq >= 0 && typeof s.invert === "boolean" &&
    !!s.voi && !!s.camera && typeof s.camera.flipH === "boolean" && typeof s.camera.flipV === "boolean" &&
    Array.isArray(s.camera.pan) && s.camera.pan.length === 2 &&
    !!s.orientation && s.orientation.normal?.length === 3 && s.orientation.up?.length === 3 &&
    [s.voi.ww, s.voi.wc, s.camera.zoom, s.camera.rotation, ...s.camera.pan, ...s.orientation.normal, ...s.orientation.up].every(Number.isFinite) && s.voi.ww > 0 && s.camera.zoom > 0;
}

export interface ImagePointEvidence {
  snapshot: ViewerSnapshot;
  imagePoint: { x: number; y: number };
  dimensions: [number, number];
}

/** Normalized canvas positions are converted by the viewer's actual image transform. */
export function imagePointEvidence(snapshot: ViewerSnapshot | null, normalized: { x: number; y: number } | null, dimensions: number[] | undefined): ImagePointEvidence | null {
  if (!snapshot || !normalized || !dimensions || dimensions.length < 2 || dimensions[0] < 2 || dimensions[1] < 2 ||
    ![normalized.x, normalized.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  return { snapshot: structuredClone(snapshot), imagePoint: { x: normalized.x * (dimensions[0] - 1), y: normalized.y * (dimensions[1] - 1) }, dimensions: [dimensions[0], dimensions[1]] };
}
