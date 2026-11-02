// Voice across a series change: hand the live session to the next viewer.
//
// The free viewer mounts one viewer per series, so "next series" by voice
// unmounted the viewer that owned the microphone. The next viewer then started
// a fresh session (worker, model, microphone) — several seconds deaf. A reader
// saying "next series … zoom in" lost the second command, and a looping
// recording could land on "next series" again every time the new session came
// up, ping-ponging between series and never hearing anything else.
//
// Instead the unmounting viewer PARKS its session here. The next viewer ADOPTS
// it (rebinding the callbacks to itself) and replays anything heard in between.
// A parked session nobody adopts is stopped after `graceMs`, and the host page
// stops it at once when it unmounts itself (`stopParkedVoice`).

import type { VoiceAction } from "./voiceCommands";
import type { VoiceProgress, VoiceSession, VoiceState } from "./voiceSession";

/** Where a running session's callbacks go; swapped when another viewer adopts it. */
export interface VoiceSink {
  onAction(action: VoiceAction, heard: string): void;
  onUnrecognized(heard: string): void;
  onProgress(progress: VoiceProgress): void;
  onState(state: VoiceState, detail?: string): void;
}

/** A session's callbacks route through this box so the owner can change. */
export interface VoiceSinkBox {
  current: VoiceSink;
}

interface Parked {
  session: VoiceSession;
  box: VoiceSinkBox;
  heard: { action: VoiceAction; heard: string }[];
  timer: ReturnType<typeof setTimeout>;
}

/** At most this many commands heard while no viewer is mounted are replayed. */
export const PARKED_REPLAY_MAX = 4;
export const PARK_GRACE_MS = 8_000;

let parked: Parked | null = null;

/** Park a live session while the viewer that owns it unmounts. */
export function parkVoice(session: VoiceSession, box: VoiceSinkBox, graceMs = PARK_GRACE_MS): void {
  stopParkedVoice();
  const entry: Parked = {
    session,
    box,
    heard: [],
    timer: setTimeout(() => {
      if (parked === entry) stopParkedVoice();
    }, graceMs),
  };
  box.current = {
    onAction: (action, heard) => {
      if (entry.heard.length < PARKED_REPLAY_MAX) entry.heard.push({ action, heard });
    },
    onUnrecognized: () => undefined,
    onProgress: () => undefined,
    // Ended while nobody owned it (mic unplugged, error): nothing to adopt.
    onState: (state) => {
      if ((state === "off" || state === "error") && parked === entry) {
        clearTimeout(entry.timer);
        parked = null;
      }
    },
  };
  parked = entry;
}

/**
 * Take over the parked session, if any: its callbacks now go to `sink`, and
 * the commands heard while parked are returned (in order) for the caller to
 * apply once it is ready. Null when nothing is parked.
 */
export function adoptParkedVoice(sink: VoiceSink): { session: VoiceSession; box: VoiceSinkBox; heard: { action: VoiceAction; heard: string }[] } | null {
  const entry = parked;
  if (!entry) return null;
  parked = null;
  clearTimeout(entry.timer);
  entry.box.current = sink;
  return { session: entry.session, box: entry.box, heard: entry.heard };
}

/** Stop and drop the parked session (host page unmounting, voice turned off). */
export function stopParkedVoice(): void {
  const entry = parked;
  if (!entry) return;
  parked = null;
  clearTimeout(entry.timer);
  entry.session.stop();
}

export function hasParkedVoice(): boolean {
  return parked !== null;
}
