// ============================================================================
// lib/recorder.ts  (client only)
//
// The "record once" half of FlowRad's record → replay mechanic. While the
// teacher HOLDS the record hotkey we capture TWO streams on ONE clock:
//
//   1. narration AUDIO  — MediaRecorder (their real voice)
//   2. an ordered, timestamped LOG of every viewer state change (slice/window/
//      zoom/pan/invert/series) PLUS annotation strokes (Length/ROI/Arrow/…)
//      PLUS a throttled cursor path (for the laser pointer)
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

export interface RecorderVideo {
  blob: Blob;
  mimeType: string;
  /** ms on the viewer clock when the first video frame was accepted. */
  offsetMs: number;
}

export interface RecorderResult {
  track: RecordedTrack;
  /** Recorded audio as base64 (no data: prefix) + its mime, for upload. */
  audio: { base64: string; mimeType: string } | null;
  /** Viewport-only video. Null when the canvas could not be captured. */
  video: RecorderVideo | null;
  /** ms on the viewer clock when the microphone actually started. */
  micOffsetMs: number;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "audio/webm";
}

function pickVideoMime(): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
}

const CURSOR_THROTTLE_MS = 40;
/**
 * How long stop() will wait for a mic that has not opened yet. A hung
 * getUserMedia must not block Save. A device that is mid-grant still attaches.
 */
const MIC_STOP_WAIT_MS = 300;

/**
 * A single-finding recorder. Construct, then call `start(priming)` with the
 * viewer's starting state; hold the hotkey; call `stop()` to finalize.
 */
export class TrackRecorder {
  private events: RecordedEvent[] = [];
  private t0 = 0;
  private clockStarted = false;
  private recording = false;
  private lastCursorT = -Infinity;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private start_: RecordedTrack["start"] = { sliceIndex: 0 };
  private micAttempt: Promise<void> = Promise.resolve();
  /** Still accept a mic that opens while stop() is finalizing. */
  private micHold = false;
  private mic: "pending" | "live" | "unavailable" = "unavailable";
  private onMic: ((state: "live" | "unavailable") => void) | null = null;
  private videoRec: MediaRecorder | null = null;
  private videoChunks: Blob[] = [];
  private videoStream: MediaStream | null = null;
  private videoOffsetMs = 0;
  private micOffsetMs = 0;

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

  /** Milliseconds on the same clock as recorded events. 0 before start. */
  elapsedMs(): number {
    if (!this.clockStarted) return 0;
    return Math.max(0, Math.round(performance.now() - this.t0));
  }

  /** The live handle the viewer wires events through. Stable across renders. */
  readonly handle: RecorderHandle = {
    onEvent: (e) => this.record(e),
    pushCursor: (x, y) => this.cursor(x, y),
  };

  /** Mic opened, or it was denied / missing / abandoned. */
  get micCapture(): "pending" | "live" | "unavailable" {
    return this.mic;
  }

  private setMic(state: "live" | "unavailable") {
    this.mic = state;
    this.onMic?.(state);
  }

  /**
   * Begin recording. `priming` is the viewer's current slice/window so replay
   * can prime the viewport before the first event. The viewer log starts
   * immediately. The microphone is best-effort and must not gate that log: a
   * denial, a missing device, or a getUserMedia call that never settles still
   * leaves `isRecording` true. A device that opens later is attached.
   */
  async start(
    priming: RecordedTrack["start"],
    hooks?: {
      onMic?: (state: "live" | "unavailable") => void;
      /** Cornerstone canvas stream. Page chrome is never captured. */
      videoStream?: MediaStream | null;
    }
  ): Promise<void> {
    this.events = [];
    this.chunks = [];
    this.rec = null;
    this.stream = null;
    this.videoRec = null;
    this.videoChunks = [];
    this.videoStream = null;
    this.videoOffsetMs = 0;
    this.micOffsetMs = 0;
    this.start_ = priming;
    this.t0 = performance.now();
    this.clockStarted = true;
    this.lastCursorT = -Infinity;
    this.recording = true;
    this.micHold = true;
    this.mic = "pending";
    this.onMic = hooks?.onMic ?? null;
    if (hooks?.videoStream && hooks.videoStream.getVideoTracks().length > 0) {
      this.startVideo(hooks.videoStream);
    }

    this.micAttempt = this.openMic();
    // Yield once so a mic that rejects on the next microtask is known before
    // we return, without waiting out a prompt or a hung getUserMedia.
    await Promise.race([
      this.micAttempt,
      new Promise<void>((resolve) => setTimeout(resolve, 0)),
    ]);
  }

  private async openMic(): Promise<void> {
    if (!TrackRecorder.supported) {
      this.setMic("unavailable");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.recording && !this.micHold) {
        stream.getTracks().forEach((t) => t.stop());
        if (this.mic === "pending") this.setMic("unavailable");
        return;
      }
      this.stream = stream;
      const mimeType = pickMime();
      const rec = new MediaRecorder(stream, { mimeType });
      this.micOffsetMs = this.elapsedMs();
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      rec.start();
      this.rec = rec;
      this.setMic("live");
    } catch {
      // Mic blocked/unavailable — record a silent track (events only).
      this.rec = null;
      this.stream = null;
      this.setMic("unavailable");
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
    // A grant that arrives as the author hits stop still belongs to this take.
    // A microphone that never answers does not hold the track hostage.
    await Promise.race([
      this.micAttempt,
      new Promise<void>((resolve) => setTimeout(resolve, MIC_STOP_WAIT_MS)),
    ]);
    this.micHold = false;
    if (this.mic === "pending") this.setMic("unavailable");

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

    const [audio, video] = await Promise.all([finishAudio(), this.finishVideo()]);

    const track: RecordedTrack = {
      durationMs,
      start: this.start_,
      // Defensive: keep events ordered by timestamp (insertion order already is).
      events: this.events.slice().sort((a, b) => a.t - b.t),
    };
    return { track, audio, video, micOffsetMs: this.micOffsetMs };
  }

  /** Viewport canvas only. Starts on the same t0 as the viewer log. */
  private startVideo(stream: MediaStream): void {
    try {
      const mimeType = pickVideoMime();
      const rec = new MediaRecorder(stream, { mimeType });
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) this.videoChunks.push(e.data);
      };
      this.videoOffsetMs = this.elapsedMs();
      rec.start(1000);
      this.videoRec = rec;
      this.videoStream = stream;
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      this.videoRec = null;
      this.videoStream = null;
    }
  }

  private finishVideo(): Promise<RecorderVideo | null> {
    return new Promise((resolve) => {
      const rec = this.videoRec;
      if (!rec) {
        this.videoStream?.getTracks().forEach((t) => t.stop());
        this.videoStream = null;
        return resolve(null);
      }
      rec.onstop = () => {
        this.videoStream?.getTracks().forEach((t) => t.stop());
        this.videoStream = null;
        const blob = new Blob(this.videoChunks, { type: rec.mimeType || "video/webm" });
        if (!blob.size) return resolve(null);
        resolve({
          blob,
          mimeType: (rec.mimeType || "video/webm").split(";")[0],
          offsetMs: this.videoOffsetMs,
        });
      };
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
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
