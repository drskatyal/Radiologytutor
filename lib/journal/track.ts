import type { JournalEntry, CaptureManifest } from "./types";
import type { RecordedEvent, RecordedTrack } from "../types";

export function trackFromJournal(journal: JournalEntry[], manifest: CaptureManifest): RecordedTrack {
  const rendered = journal.find(e => e.kind === "render");
  const first = rendered?.snapshot;
  const displayIndex = rendered?.payload?.displayIndex;
  return {
    durationMs: manifest.durationMs,
    start: { sliceIndex: typeof displayIndex === "number" && Number.isInteger(displayIndex) && displayIndex >= 0 ? displayIndex : 0, ...(first ? { snapshot: first, studyInstanceUID: first.studyUID, seriesInstanceUID: first.seriesUID, sopInstanceUID: first.sopUID, frameNumber: first.frame, ww: first.voi.ww, wc: first.voi.wc, ...first.camera, invert: first.invert, layout: first.layout } : {}) },
    events: journal.filter(e => e.kind === "input" && e.payload?.event).map(e => ({ ...(e.payload!.event as RecordedEvent), t: e.t })),
    journal, captureSessionId: manifest.sessionId, mediaManifest: manifest,
    audioOffsetMs: manifest.offsets.audio, videoOffsetMs: manifest.offsets.video,
  };
}
