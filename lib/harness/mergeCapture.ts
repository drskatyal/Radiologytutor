/**
 * Merge a continuous demonstration: speech segments (structured JSON) +
 * timestamped DICOM walk-through (RecordedTrack) → Finding drafts + CaptureSession.
 *
 * This is the harness “learn from demonstration” step — Grok Bot’s routine
 * capture, scoped to radiology teaching. See docs/HARNESS.md.
 */

import {
  markerNearTime,
  seriesNearTime,
  sliceTrack,
  segmentMidMs,
} from "../captureSession";
import type {
  CaptureSession,
  Finding,
  FindingAnchor,
  Marker,
  RecordedTrack,
  StructuredSessionFinding,
} from "../types";

export type MergeCaptureInput = {
  sessionId: string;
  parentTrack: RecordedTrack;
  segments: StructuredSessionFinding[];
  transcript?: string;
  audioUrl?: string;
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  /** Live viewport SOP when the take ended (best-effort). */
  sopInstanceUID?: string;
  createdAt?: string;
};

export type MergedCapture = {
  session: CaptureSession;
  findings: Partial<Finding>[];
};

/**
 * Align each speech segment to the viewer clock and materialize Finding drafts.
 */
export function mergeCaptureDemonstration(input: MergeCaptureInput): MergedCapture {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const track: RecordedTrack = {
    ...input.parentTrack,
    audioUrl: input.audioUrl ?? input.parentTrack.audioUrl,
  };

  const session: CaptureSession = {
    id: input.sessionId,
    durationMs: track.durationMs,
    track,
    audioUrl: input.audioUrl,
    transcript: input.transcript,
    createdAt,
  };

  const findings: Partial<Finding>[] = [];
  for (let i = 0; i < input.segments.length; i++) {
    const seg = input.segments[i];
    if (!seg.label?.trim()) continue;

    const mid = segmentMidMs(seg.tStartMs, seg.tEndMs);
    const marker: Marker =
      seg.suggestedMarker ??
      markerNearTime(track, mid) ?? { x_pct: 0.5, y_pct: 0.5, shape: "circle" };
    const sub = sliceTrack(track, seg.tStartMs, seg.tEndMs);
    if (input.audioUrl) sub.audioUrl = input.audioUrl;

    // Prefer the last slice / VOI the teacher used *during* the utterance
    // (events inside the sliced track), not only the state frozen at tStart.
    let landingSlice = sub.start.sliceIndex;
    let ww = sub.start.ww;
    let wc = sub.start.wc;
    for (const e of sub.events) {
      if (e.type === "slice") landingSlice = e.index;
      if (e.type === "voi") {
        ww = e.ww;
        wc = e.wc;
      }
    }

    const sliceIndex =
      seg.suggestedSliceIndex ??
      landingSlice ??
      0;
    const seriesUID =
      seriesNearTime(track, mid) ||
      input.seriesInstanceUID ||
      undefined;

    const snap = {
      sliceIndex,
      ww,
      wc,
      sopInstanceUID: input.sopInstanceUID,
    };

    const anchor: FindingAnchor = {
      studyInstanceUID: input.studyInstanceUID,
      seriesInstanceUID: seriesUID,
      marker,
      sliceIndex: snap.sliceIndex,
      windowWidth: snap.ww,
      windowCenter: snap.wc,
      sopInstanceUID: snap.sopInstanceUID,
      viewportRole: "primary",
      studyRole: "current",
    };

    const finding: Partial<Finding> = {
      label: seg.label.trim(),
      description: (seg.description ?? "").trim(),
      teachingPoints: (seg.teachingPoints ?? []).map((t) => t.trim()).filter(Boolean),
      state: " ",
      marker,
      studyInstanceUID: input.studyInstanceUID,
      seriesInstanceUID: seriesUID,
      anchors: [anchor],
      track: sub,
      durationMs: sub.durationMs,
      captureSessionId: session.id,
      tStartMs: seg.tStartMs,
      tEndMs: seg.tEndMs,
      sliceIndex: snap.sliceIndex,
      windowWidth: snap.ww,
      windowCenter: snap.wc,
      sopInstanceUID: snap.sopInstanceUID,
      order: i + 1,
    };
    findings.push(finding);
  }

  return { session, findings };
}
