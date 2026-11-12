import type { RecordedTrack } from "../types";
import { validSnapshot } from "../journal/viewer";
import { ReplayError, type ReplayPlan, type AudioGap } from "./types";

/** Never turn requested input/index events into confirmed image identity. */
export function replayPlan(track: RecordedTrack, hasAudio: boolean): ReplayPlan {
  const journal = track.journal;
  if (!journal?.length || !Number.isFinite(track.durationMs) || track.durationMs <= 0) throw new ReplayError("missing_journal", "Exact replay requires a retained image journal. Re-record this take.");
  const initial = track.start.snapshot ?? journal.find(e => e.kind === "render")?.snapshot;
  if (!initial || !validSnapshot(initial)) throw new ReplayError("missing_identity", "Image not found: rebind or re-record the take.");
  let lastT = -1, lastSeq = -Infinity;
  for (const entry of journal) {
    if (!Number.isInteger(entry.seq) || entry.seq <= lastSeq || !Number.isFinite(entry.t) || entry.t < 0 || entry.t < lastT || entry.t > track.durationMs) throw new ReplayError("invalid_journal", "The replay journal is out of order.", entry.seq);
    if (["render", "layout"].includes(entry.kind) && (!entry.snapshot || !validSnapshot(entry.snapshot) || entry.snapshot.renderSeq !== entry.renderSeq)) throw new ReplayError("missing_identity", "Image not found: rebind or re-record the take.", entry.seq);
    if (!["render", "layout", "marker", "annotation", "measurement", "input", "discontinuity"].includes(entry.kind)) throw new ReplayError("invalid_journal", "Unknown replay journal entry.", entry.seq);
    lastT = entry.t; lastSeq = entry.seq;
  }
  if (!journal.some(e => e.kind === "render")) throw new ReplayError("missing_identity", "No confirmed images were retained.");
  if (hasAudio && journal[0].seq !== 0) throw new ReplayError("partial_audio_timeline", "Replay the full retained take: this excerpt cannot prove earlier audio gaps.");
  const offsetMs = track.audioOffsetMs ?? track.mediaManifest?.offsets.audio;
  const chunks = track.mediaManifest?.chunks.filter(c => c.stream === "audio") ?? [];
  const gaps: AudioGap[] = []; let pause: number | null = null;
  for (const entry of journal) {
    if (entry.kind !== "discontinuity") continue;
    const p = entry.payload;
    if (p?.reason === "page_interrupted" || p?.reason === "marker_without_rendered_image") throw new ReplayError("incomplete_capture", "This capture has an unresolved interruption; exact replay is unavailable.", entry.seq);
    if (!hasAudio || p?.stream !== "audio") continue;
    if (["media_error", "media_delivery_gap"].includes(String(p.reason))) throw new ReplayError("audio_gap", "Audio gap detected. Timing is uncertain; exact replay stopped.", entry.seq);
    if (p.reason === "media_pause") { if (pause !== null) throw new ReplayError("audio_gap", "Unmatched audio pause.", entry.seq); pause = entry.t; }
    if (p.reason === "media_resume") { if (pause === null) throw new ReplayError("audio_gap", "Unmatched audio resume.", entry.seq); gaps.push({ startMs: pause, endMs: entry.t }); pause = null; }
  }
  if (pause !== null) throw new ReplayError("audio_gap", "Audio pause has no retained resume.");
  if (hasAudio && !Number.isFinite(offsetMs)) throw new ReplayError("audio_offset", "The recorded audio offset is missing.");
  for (let i = 1; i < chunks.length; i++) if (Math.abs(chunks[i].tStart - chunks[i - 1].tEnd) > 1) throw new ReplayError("audio_gap", "Audio chunks do not form a continuous retained stream.");
  return { journal: structuredClone(journal), initial: structuredClone(initial), durationMs: track.durationMs,
    audio: hasAudio ? { offsetMs: offsetMs!, endMs: chunks.at(-1)?.tEnd ?? track.durationMs, gaps } : null };
}
/** Map shared capture time into the decoded stream; a recorded pause is silence. */
export function audioPosition(t: number, audio: NonNullable<ReplayPlan["audio"]>): number | null {
  if (t < audio.offsetMs || t >= audio.endMs || audio.gaps.some(g => t >= g.startMs && t < g.endMs)) return null;
  return t - audio.offsetMs - audio.gaps.reduce((sum, g) => sum + (t >= g.endMs ? g.endMs - g.startMs : 0), 0);
}
export function audioSegments(from: number, until: number, audio: NonNullable<ReplayPlan["audio"]>) {
  const boundaries = [...new Set([Math.max(from, audio.offsetMs), Math.min(until, audio.endMs), ...audio.gaps.flatMap(g => [g.startMs, g.endMs]).filter(t => t > from && t < until)])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).flatMap((t, i) => {
    const end = Math.min(boundaries[i + 1], until, audio.endMs), positionMs = audioPosition(t, audio);
    return positionMs !== null && end > t && t >= from && t < until ? [{ startMs: t, endMs: end, positionMs }] : [];
  });
}
