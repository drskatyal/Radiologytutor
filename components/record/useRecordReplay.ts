"use client";

// Record → replay session hook, shared by the /record demo and the author
// capture surface. It owns:
//
//   • the Alt+X HOLD-to-record hotkey (ignored while typing in inputs),
//   • a TrackRecorder that captures the viewer event stream + narration audio
//     on one clock (wired to CornerstoneViewer's onEvent + cursor capture),
//   • replay via lib/replay locked to a narration <audio> element, painting the
//     laser pointer / annotation overlay through a ReplayOverlay handle.
//
// The viewer/overlay are owned by the caller; this hook just wires the handles
// it's given. Everything is client-only (mic, rAF, performance.now).

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { TrackRecorder } from "@/lib/recorder";
import { startReplay, type ReplayController } from "@/lib/replay";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ReplayOverlayHandle } from "@/components/ReplayOverlay";
import type { RecordedTrack, ViewerEvent } from "@/lib/types";
import {
  pushViewportStill,
  VIEWPORT_SAMPLE_MS,
  type CompileFrame,
} from "@/lib/compileMedia";

export type RecordPhase = "idle" | "recording" | "replaying";

export interface UploadedAudio {
  url: string;
  base64: string;
  mimeType: string;
}

export interface UseRecordReplay {
  phase: RecordPhase;
  /** Whether mic capture is supported in this browser. */
  supported: boolean;
  /**
   * Microphone for the take in progress (or the one just finished).
   * `unavailable` means the viewer track is recording without audio.
   */
  micCapture: "unknown" | "live" | "unavailable";
  /** ms elapsed in the current recording (live HUD). */
  elapsedMs: number;
  /** The most recent finalized track (null until a recording completes). */
  track: RecordedTrack | null;
  /** Raw audio of the most recent recording (for upload by the caller). */
  audio: { base64: string; mimeType: string } | null;
  /**
   * Viewport stills from the take that just finished. Empty when the mic was
   * off or the imaging surface could not be read. Students never see these.
   */
  frames: CompileFrame[];
  /** Replay progress [0,1]. */
  progress: number;
  /** Wire to CornerstoneViewer's onEvent (records while recording). */
  onViewerEvent: (e: ViewerEvent) => void;
  /** Call from a pointer handler over the viewport (normalized 0..1). */
  onCursor: (x: number, y: number) => void;
  /** Begin recording (also driven by the Alt+X hotkey). False if the viewer is not ready. */
  startRecording: () => Promise<boolean>;
  stopRecording: () => Promise<{
    track: RecordedTrack;
    audio: { base64: string; mimeType: string } | null;
    frames: CompileFrame[];
  } | null>;
  /** Replay a track (defaults to the last recorded one). */
  replay: (track?: RecordedTrack, audioUrl?: string) => void;
  stopReplay: () => void;
  /** Discard the last recording. */
  reset: () => void;
}

/** True when the event target is a text input we must not hijack the hotkey in. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Best-effort imaging still. A throw or a blank canvas must not stop the take. */
function readViewportStill(
  controls: CornerstoneControls | null
): { mimeType: string; base64: string } | null {
  if (!controls?.captureViewportStill) return null;
  try {
    return controls.captureViewportStill();
  } catch {
    return null;
  }
}

export function useRecordReplay(opts: {
  controls: MutableRefObject<CornerstoneControls | null>;
  overlay: MutableRefObject<ReplayOverlayHandle | null>;
  ready: boolean;
}): UseRecordReplay {
  const { controls, overlay, ready } = opts;

  const [phase, setPhase] = useState<RecordPhase>("idle");
  const [micCapture, setMicCapture] = useState<"unknown" | "live" | "unavailable">("unknown");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [track, setTrack] = useState<RecordedTrack | null>(null);
  const [audio, setAudio] = useState<{ base64: string; mimeType: string } | null>(null);
  const [frames, setFrames] = useState<CompileFrame[]>([]);
  const [progress, setProgress] = useState(0);

  const recorderRef = useRef<TrackRecorder | null>(null);
  const framesRef = useRef<CompileFrame[]>([]);
  const replayRef = useRef<ReplayController | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef = useRef<RecordPhase>("idle");
  phaseRef.current = phase;

  const supported = TrackRecorder.supported;

  // --- Recording ------------------------------------------------------------
  const startRecording = useCallback(async (): Promise<boolean> => {
    if (phaseRef.current !== "idle" || !ready || !controls.current) return false;
    // Cancel any in-flight replay first.
    replayRef.current?.cancel();
    replayRef.current = null;
    overlay.current?.clear();

    const rec = new TrackRecorder();
    recorderRef.current = rec;
    framesRef.current = [];
    setFrames([]);
    const priming = controls.current.getStartState();
    setMicCapture("unknown");
    await rec.start(priming, { onMic: (state) => setMicCapture(state) });
    setPhase("recording");
    setElapsedMs(0);
    const t0 = performance.now();
    elapsedTimerRef.current = setInterval(
      () => setElapsedMs(Math.round(performance.now() - t0)),
      100
    );
    return true;
  }, [ready, controls, overlay]);

  const stopRecording = useCallback(async (): Promise<{
    track: RecordedTrack;
    audio: { base64: string; mimeType: string } | null;
    frames: CompileFrame[];
  } | null> => {
    const rec = recorderRef.current;
    if (!rec || phaseRef.current !== "recording") return null;
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
    if (rec.micCapture === "live") {
      const shot = readViewportStill(controls.current);
      if (shot) {
        framesRef.current = pushViewportStill(framesRef.current, {
          tMs: rec.elapsedMs(),
          mimeType: shot.mimeType,
          base64: shot.base64,
        });
      }
    }
    const { track: newTrack, audio: newAudio } = await rec.stop();
    const stills = framesRef.current;
    recorderRef.current = null;
    setTrack(newTrack);
    setAudio(newAudio);
    setFrames(stills);
    setPhase("idle");
    return { track: newTrack, audio: newAudio, frames: stills };
  }, [controls]);

  // --- Replay ---------------------------------------------------------------
  const stopReplay = useCallback(() => {
    replayRef.current?.cancel();
    replayRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current = null;
    }
    overlay.current?.clear();
    setProgress(0);
    setPhase((p) => (p === "replaying" ? "idle" : p));
  }, [overlay]);

  const replay = useCallback(
    (which?: RecordedTrack, audioUrl?: string) => {
      const t = which ?? track;
      if (!t || !controls.current || phaseRef.current === "recording") return;
      stopReplay();

      const url = audioUrl ?? t.audioUrl;
      let audioEl: HTMLAudioElement | null = null;
      if (url) {
        audioEl = new Audio(url);
        audioElRef.current = audioEl;
        // Best-effort; replay falls back to a wall clock if play() is blocked.
        audioEl.play().catch(() => {});
      }

      setPhase("replaying");
      setProgress(0);
      const ctrl = startReplay(
        t,
        {
          applyEvent: (e) => controls.current?.applyEvent(e),
          getStartState: () => controls.current?.getStartState() ?? { sliceIndex: 0 },
        },
        {
          audio: audioEl,
          overlay: {
            cursor: (x, y) => overlay.current?.cursor(x, y),
            annotation: (e) => overlay.current?.annotation(e),
            clear: () => overlay.current?.clear(),
          },
          onProgress: (f) => setProgress(f),
          onEnd: () => {
            audioElRef.current = null;
            setPhase("idle");
            setProgress(1);
          },
        }
      );
      replayRef.current = ctrl;
    },
    [track, controls, overlay, stopReplay]
  );

  const reset = useCallback(() => {
    stopReplay();
    framesRef.current = [];
    setTrack(null);
    setAudio(null);
    setFrames([]);
    setProgress(0);
    setMicCapture("unknown");
  }, [stopReplay]);

  // Viewport stills share the recorder clock, and only while the mic is live.
  // A failed grab is ignored — the track and audio still save.
  useEffect(() => {
    if (phase !== "recording" || micCapture !== "live") return;
    const sample = () => {
      const rec = recorderRef.current;
      if (!rec || rec.micCapture !== "live") return;
      const shot = readViewportStill(controls.current);
      if (!shot) return;
      framesRef.current = pushViewportStill(framesRef.current, {
        tMs: rec.elapsedMs(),
        mimeType: shot.mimeType,
        base64: shot.base64,
      });
    };
    sample();
    const id = window.setInterval(sample, VIEWPORT_SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [phase, micCapture, controls]);

  // --- Alt+X hold-to-record hotkey -----------------------------------------
  useEffect(() => {
    const isHotkey = (e: KeyboardEvent) =>
      e.altKey && (e.key === "x" || e.key === "X" || e.code === "KeyX");

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isHotkey(e) || e.repeat) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (phaseRef.current === "idle") void startRecording();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Release on either Alt or X up — keeps it forgiving.
      if (!(e.key === "x" || e.key === "X" || e.code === "KeyX" || e.key === "Alt")) return;
      if (phaseRef.current === "recording") {
        e.preventDefault();
        void stopRecording();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startRecording, stopRecording]);

  // --- Wiring sinks ---------------------------------------------------------
  const onViewerEvent = useCallback((e: ViewerEvent) => {
    recorderRef.current?.handle.onEvent(e);
  }, []);
  const onCursor = useCallback((x: number, y: number) => {
    recorderRef.current?.handle.pushCursor(x, y);
  }, []);

  // Cleanup.
  useEffect(
    () => () => {
      replayRef.current?.cancel();
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      audioElRef.current?.pause();
    },
    []
  );

  return {
    phase,
    supported,
    micCapture,
    elapsedMs,
    track,
    audio,
    frames,
    progress,
    onViewerEvent,
    onCursor,
    startRecording,
    stopRecording,
    replay,
    stopReplay,
    reset,
  };
}
