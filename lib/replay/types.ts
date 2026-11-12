import type { JournalEntry, ViewerSnapshot } from "../journal/types";
import type { ImageGeometry, ImagePoint, Vec3 } from "../anchors/geometry";
export class ReplayError extends Error {
  constructor(readonly code: string, message: string, readonly seq: number | null = null) { super(message); this.name = "ReplayError"; }
}
export interface AudioGap { startMs: number; endMs: number }
export interface ReplayPlan {
  journal: JournalEntry[]; initial: ViewerSnapshot; durationMs: number;
  audio: { offsetMs: number; endMs: number; gaps: AudioGap[] } | null;
}
export interface ReplayShape {
  id: string; kind: "marker" | "annotation"; tool: string; label: string;
  snapshot: ViewerSnapshot; dimensions: [number, number]; imagePoints: ImagePoint[];
  patientPoints: Array<Vec3 | null>; geometry: ImageGeometry; lengthMm: number | null;
}
export interface ProjectedReplayShape extends ReplayShape { canvasPoints: Array<{ x: number; y: number }> }
export interface ReplayMiss { seq: number | null; t: number; code: string; message: string }
export interface ReplayResult {
  outcome: "completed" | "failed" | "cancelled";
  confirmations: Array<{ seq: number | null; t: number; snapshot: ViewerSnapshot; waitMs: number }>;
  misses: ReplayMiss[];
}
export interface ReplayState { phase: "loading" | "waiting" | "playing" | "completed" | "failed" | "cancelled"; elapsedMs: number; seq: number | null; message: string }
export interface ReplayRun extends ReplayResult { id: string; captureSessionId: string; findingId: string; version: number; contentHash: string; recordedAt: string; recordedBy: string }
