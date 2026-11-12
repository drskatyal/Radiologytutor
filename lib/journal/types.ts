/** Journal v1: image identity and displayed state, never a requested stack index. */
export interface ViewerSnapshot {
  studyUID: string; seriesUID: string; sopUID: string; frame: number;
  viewportId: string; layout: string;
  voi: { ww: number; wc: number }; invert: boolean;
  camera: { zoom: number; pan: [number, number]; rotation: number; flipH: boolean; flipV: boolean };
  orientation: { normal: number[]; up: number[] };
  renderSeq: number;
}
export interface RenderedView { snapshot: ViewerSnapshot; /** performance.now(), same origin as recorder t0. */ at: number }
export interface ViewCommand { commandId: string; generation: number; snapshot: ViewerSnapshot; timeoutMs?: number }
export interface RenderAck extends RenderedView { commandId: string; generation: number }
export interface JournalEntry {
  seq: number; t: number;
  kind: "render" | "input" | "marker" | "annotation" | "measurement" | "layout" | "discontinuity";
  snapshot?: ViewerSnapshot; renderSeq?: number;
  payload?: Record<string, unknown>;
}
export type CaptureStream = "journal" | "audio" | "video";
export interface CaptureChunk {
  seq: number; stream: CaptureStream; tStart: number; tEnd: number;
  sha256: string; bytes: number; mime: string;
}
export interface CaptureManifest {
  version: 1; sessionId: string; caseId: string; createdAt: string;
  status: "recording" | "interrupted" | "complete";
  chunks: CaptureChunk[];
  durationMs: number;
  offsets: { audio?: number; video?: number };
  /** Unknown media cannot be published or sent to a model without expert review. */
  phiReview: { pixels: boolean; audio: boolean; screen: boolean };
}
