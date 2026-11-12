import type { RecordedTrack } from "../types";
import type { JournalEntry } from "../journal/types";
import { retainedMarkers, resolveAnchor, type ResolvedAnchor } from "./resolve";

export type MarkerDecision = { kind: "group" | "omit"; markerIds: string[]; reason: string };
export interface MarkerAssignment { markerId: string; markerIds: string[]; reconciliation: { kind: "single" | "group"; markerIds: string[]; reason?: string }; resolvedAnchor: ResolvedAnchor }
export function reconcileMarkers(journal: readonly JournalEntry[], decisions: readonly MarkerDecision[] = []): { drafts: MarkerAssignment[]; omitted: MarkerDecision[]; retained: number } {
  if (!Array.isArray(decisions)) throw new Error("Invalid marker reconciliation decisions");
  const markers = retainedMarkers(journal), ids = markers.map(e => e.payload!.markerId as string), consumed = new Set<string>();
  for (const d of decisions) {
    if (!d || !["group", "omit"].includes(d.kind) || !Array.isArray(d.markerIds) || (typeof d.reason !== "string" || !d.reason.trim()) || d.markerIds.length < (d.kind === "group" ? 2 : 1)) throw new Error("Invalid marker reconciliation decision");
    for (const id of d.markerIds) { if (!ids.includes(id) || consumed.has(id)) throw new Error("Marker reconciliation references a missing or repeated marker"); consumed.add(id); }
  }
  const drafts: MarkerAssignment[] = [];
  for (const id of ids) {
    const decision = decisions.find(d => d.markerIds.includes(id));
    if (decision?.kind === "omit" || (decision && decision.markerIds[0] !== id)) continue;
    const markerIds = decision?.markerIds ?? [id];
    drafts.push({ markerId: id, markerIds: [...markerIds], reconciliation: { kind: decision ? "group" : "single", markerIds: [...markerIds], ...(decision ? { reason: decision.reason.trim() } : {}) }, resolvedAnchor: resolveAnchor(id, journal) });
  }
  return { drafts, omitted: structuredClone(decisions.filter(d => d.kind === "omit")), retained: ids.length };
}
export interface MarkerText { markerId?: string; label: string; description?: string; teachingPoints?: string[]; tStartMs: number; tEndMs: number }
/** Text windows may suggest prose for a marker, never supply its image identity. */
export function reconcileDrafts<T extends MarkerText>(track: RecordedTrack, text: readonly T[], decisions: readonly MarkerDecision[] = []): Array<T & Partial<MarkerAssignment>> {
  const result = reconcileMarkers(track.journal ?? [], decisions);
  if (!result.retained) return text.filter(t => !t.markerId || !(track.journal ?? []).some(e => e.kind === "marker" && e.payload?.markerId === t.markerId)).map(t => ({ ...t, resolvedAnchor: resolveAnchor(t.markerId, track.journal ?? []) }));
  return result.drafts.map((assignment, i) => {
    const e = retainedMarkers(track.journal ?? []).find(e => e.payload!.markerId === assignment.markerId)!;
    const prose = text.find(t => t.markerId === assignment.markerId) ?? text.find(t => !t.markerId && t.tStartMs <= e.t && t.tEndMs >= e.t);
    const base = prose ?? { label: `Finding ${i + 1}`, description: "", teachingPoints: [], tStartMs: e.t, tEndMs: Math.max(e.t, track.durationMs) } as unknown as T;
    return { ...base, ...assignment };
  });
}
