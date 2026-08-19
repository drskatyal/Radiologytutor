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
  /** ms elapsed in the current recording (live HUD). */
  elapsedMs: number;
  /** The most recent finalized track (null until a recording completes). */
  track: RecordedTrack | null;
  /** Raw audio of the most recent recording (for upload by the caller). */
  audio: { base64: string; mimeType: string } | null;
  /** Replay progress [0,1]. */
  progress: number;
  /** Wire to CornerstoneViewer's onEvent (records while recording). */
  onViewerEvent: (e: ViewerEvent) => void;
  /** Call from a pointer handler over the viewport (normalized 0..1). */
  onCursor: (x: number, y: number) => void;
  /** Begin/stop recording (also driven by the Alt+X hotkey). */
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<{
    track: RecordedTrack;
    audio: { base64: string; mimeType: string } | null;
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

export function useRecordReplay(opts: {
  controls: MutableRefObject<CornerstoneControls | null>;
  overlay: MutableRefObject<ReplayOverlayHandle | null>;
  ready: boolean;
}): UseRecordReplay {
  const { controls, overlay, ready } = opts;

  const [phase, setPhase] = useState<RecordPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [track, setTrack] = useState<RecordedTrack | null>(null);
  const [audio, setAudio] = useState<{ base64: string; mimeType: string } | null>(null);
  const [progress, setProgress] = useState(0);

  const recorderRef = useRef<TrackRecorder | null>(null);
  const replayRef = useRef<ReplayController | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef = useRef<RecordPhase>("idle");
  phaseRef.current = phase;

  const supported = TrackRecorder.supported;

  // --- Recording ------------------------------------------------------------
  const startRecording = useCallback(async () => {
    if (phaseRef.current !== "idle" || !ready || !controls.current) return;
    // Cancel any in-flight replay first.
    replayRef.current?.cancel();
    replayRef.current = null;
    overlay.current?.clear();

    const rec = new TrackRecorder();
    recorderRef.current = rec;
    const priming = controls.current.getStartState();
    await rec.start(priming);
    setPhase("recording");
    setElapsedMs(0);
    const t0 = performance.now();
    elapsedTimerRef.current = setInterval(
      () => setElapsedMs(Math.round(performance.now() - t0)),
      100
    );
  }, [ready, controls, overlay]);

  const stopRecording = useCallback(async (): Promise<{
    track: RecordedTrack;
    audio: { base64: string; mimeType: string } | null;
  } | null> => {
    const rec = recorderRef.current;
    if (!rec || phaseRef.current !== "recording") return null;
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
    const { track: newTrack, audio: newAudio } = await rec.stop();
    recorderRef.current = null;
    setTrack(newTrack);
    setAudio(newAudio);
    setPhase("idle");
    return { track: newTrack, audio: newAudio };
  }, []);

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
    setTrack(null);
    setAudio(null);
    setProgress(0);
  }, [stopReplay]);

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
    elapsedMs,
    track,
    audio,
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
