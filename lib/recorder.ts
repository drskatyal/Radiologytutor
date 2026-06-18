// ============================================================================
// lib/recorder.ts  (client only)
//
// The "record once" half of FlowRad's record → replay mechanic. While the
// teacher HOLDS the record hotkey we capture TWO streams on ONE clock:
//
//   1. narration AUDIO  — MediaRecorder (their real voice)
//   2. an ordered, timestamped LOG of every viewer state change (slice/window/
//      zoom/pan/invert) PLUS a throttled cursor path (for the laser pointer)
//
// Both are stamped with `t = performance.now() - t0` so replay can re-apply the
// exact same events, in the same order, locked to `audio.currentTime`. No
// segmentation, no automation: record a list, replay a list.
//
// The recorder is intentionally UI-agnostic. It exposes `onEvent`, which the
// CornerstoneViewer wires to its `onEvent` prop, and a `pushCursor` the viewer's
// overlay calls on (throttled) mousemove. `start()` opens the mic; `stop()`
// returns a RecordedTrack with the audio as a base64 data payload + object URL.
// ============================================================================

import type { RecordedEvent, RecordedTrack, ViewerEvent } from "./types";

export interface RecorderHandle {
  /** Wire this to CornerstoneViewer's `onEvent` prop. */
  onEvent: (e: ViewerEvent) => void;
  /** Throttled normalized cursor position over the viewport (laser pointer). */
  pushCursor: (x: number, y: number) => void;
}

export interface RecorderResult {
  track: RecordedTrack;
  /** Recorded audio as base64 (no data: prefix) + its mime, for upload. */
  audio: { base64: string; mimeType: string } | null;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "audio/webm";
}

const CURSOR_THROTTLE_MS = 40;

/**
 * A single-finding recorder. Construct, then call `start(priming)` with the
 * viewer's starting state; hold the hotkey; call `stop()` to finalize.
 */
export class TrackRecorder {
  private events: RecordedEvent[] = [];
  private t0 = 0;
  private recording = false;
  private lastCursorT = -Infinity;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private start_: RecordedTrack["start"] = { sliceIndex: 0 };

  /** Whether mic capture is even possible in this environment. */
  static get supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof MediaRecorder !== "undefined"
    );
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /** The live handle the viewer wires events through. Stable across renders. */
  readonly handle: RecorderHandle = {
    onEvent: (e) => this.record(e),
    pushCursor: (x, y) => this.cursor(x, y),
  };

  /**
   * Begin recording. `priming` is the viewer's current slice/window so replay
   * can prime the viewport before the first event. Mic is best-effort: if it's
   * denied or unavailable we still record the event log (silent track).
   */
  async start(priming: RecordedTrack["start"]): Promise<void> {
    this.events = [];
    this.chunks = [];
    this.start_ = priming;
    this.t0 = performance.now();
    this.lastCursorT = -Infinity;
    this.recording = true;

    if (!TrackRecorder.supported) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.stream = stream;
      const mimeType = pickMime();
      const rec = new MediaRecorder(stream, { mimeType });
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      rec.start();
      this.rec = rec;
    } catch {
      // Mic blocked/unavailable — record a silent track (events only).
      this.rec = null;
    }
  }

  private record(e: ViewerEvent): void {
    if (!this.recording) return;
    const t = Math.round(performance.now() - this.t0);
    this.events.push({ ...e, t } as RecordedEvent);
  }

  private cursor(x: number, y: number): void {
    if (!this.recording) return;
    const now = performance.now();
    if (now - this.lastCursorT < CURSOR_THROTTLE_MS) return;
    this.lastCursorT = now;
    this.events.push({ t: Math.round(now - this.t0), type: "cursor", x, y });
  }

  /** Stop and finalize. Resolves with the ordered track + recorded audio. */
  async stop(): Promise<RecorderResult> {
    this.recording = false;
    const durationMs = Math.round(performance.now() - this.t0);

    const finishAudio = (): Promise<RecorderResult["audio"]> =>
      new Promise((resolve) => {
        const rec = this.rec;
        if (!rec) return resolve(null);
        rec.onstop = async () => {
          this.stream?.getTracks().forEach((t) => t.stop());
          this.stream = null;
          const blob = new Blob(this.chunks, { type: rec.mimeType });
          const base64 = await blobToBase64(blob);
          resolve(
            base64
              ? { base64, mimeType: rec.mimeType.split(";")[0] }
              : null
          );
        };
        try {
          rec.stop();
        } catch {
          resolve(null);
        }
      });

    const audio = await finishAudio();

    const track: RecordedTrack = {
      durationMs,
      start: this.start_,
      // Defensive: keep events ordered by timestamp (insertion order already is).
      events: this.events.slice().sort((a, b) => a.t - b.t),
    };
    return { track, audio };
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
