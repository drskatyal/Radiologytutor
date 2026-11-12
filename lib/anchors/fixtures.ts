import type { RecordedTrack } from "../types";
import { journalTestView } from "../journal/fixtures";
import { geometryFromDicom } from "./geometry";
export const plane = { "00280030": { Value: [0.7, 0.9] }, "00200032": { Value: [10, 20, 30] }, "00200037": { Value: [1, 0, 0, 0, 1, 0] } };
export function markerTrack(): RecordedTrack {
  const track: RecordedTrack = { start: { sliceIndex: 0 }, events: [], durationMs: 1000, captureSessionId: "synthetic-markers", journal: [] };
  for (let i = 0; i < 3; i++) {
    const snapshot = { ...structuredClone(journalTestView), sopUID: `1.2.3.${i + 4}`, frame: 1, renderSeq: i + 1 };
    track.journal!.push({ seq: i * 2, t: i * 100, kind: "render", renderSeq: snapshot.renderSeq, snapshot, payload: { displayIndex: i } }, { seq: i * 2 + 1, t: i * 100 + 20, kind: "marker", renderSeq: snapshot.renderSeq, snapshot, payload: { markerId: `marker-${i}`, imagePoint: { x: 10 + i, y: 20 }, dimensions: [64, 64], geometry: geometryFromDicom(plane, 1) } });
  }
  return track;
}
