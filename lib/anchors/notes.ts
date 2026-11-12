import type { RecordedTrack, StructuredSessionFinding } from "../types";
import { reconcileDrafts, type MarkerAssignment } from "./reconcile";
import { retainedMarkers } from "./resolve";
/** Silent take candidates are created from identities, without an AI call. */
export function notesDrafts(track: RecordedTrack): Array<StructuredSessionFinding & Partial<MarkerAssignment>> {
  const markers = retainedMarkers(track.journal ?? []);
  return reconcileDrafts(track, markers.map(e => ({ markerId: e.payload!.markerId as string, label: "", description: "", teachingPoints: [], tStartMs: e.t, tEndMs: Math.max(e.t, track.durationMs) })));
}
