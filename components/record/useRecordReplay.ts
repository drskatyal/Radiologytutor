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

import { studioHotkey } from "@/lib/studioHotkeys";
import type { JournalEntry } from "@/lib/journal/types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { JournalRecorder, recoverCapture } from "@/lib/journal/recorder";
import { captureBase } from "@/lib/journal/sync";
import { captureLocalStore, type LocalCapture } from "@/lib/journal/localStore";
import type { RenderConfirmedViewer } from "@/lib/viewerController";
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
import type { RecorderVideo } from "@/lib/recorder";

export interface TakePlayback {
  videoUrl: string | null;
  videoBlob: Blob | null;
  videoMime: string | null;
  videoOffsetMs: number;
  audioUrl: string | null;
  audioOffsetMs: number;
}

const EMPTY_PLAYBACK: TakePlayback = {
  videoUrl: null,
  videoBlob: null,
  videoMime: null,
  videoOffsetMs: 0,
  audioUrl: null,
  audioOffsetMs: 0,
};

export type RecordPhase = "idle" | "starting" | "recording" | "stopping" | "replaying";

export interface UploadedAudio {
  url: string;
  base64: string;
  mimeType: string;
}

export interface UseRecordReplay {
  phase: RecordPhase;
  captureError?: string;
  mediaReviewed?: boolean;
  reviewMedia?: () => Promise<void>;
  acknowledgedChunks?: number;
  recoverable?: LocalCapture[];
  recoveredSessionId?: string;
  recover?: (sessionId: string) => Promise<void>;
  onMarker?: (x: number, y: number) => void;
  pendingMarkers?: JournalEntry[];
  removeMarker?: (id: string) => void;
  undoMarker?: () => void;
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
  /**
   * Object URLs for the take that just finished. Viewport video is the
   * Cornerstone canvas only. Absent until the first stop, and optional so
   * harnesses that stub the hook still type-check.
   */
  playback?: TakePlayback;
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

function releasePlayback(current: TakePlayback) {
  if (typeof URL === "undefined") return;
  if (current.videoUrl) URL.revokeObjectURL(current.videoUrl);
  if (current.audioUrl) URL.revokeObjectURL(current.audioUrl);
}

function base64ToBlob(base64: string, mime: string): Blob | null {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

function playbackFromStop(
  video: RecorderVideo | null,
  audio: { base64: string; mimeType: string } | null,
  micOffsetMs: number
): TakePlayback {
  const audioBlob = audio ? base64ToBlob(audio.base64, audio.mimeType) : null;
  return {
    videoUrl: video && typeof URL !== "undefined" ? URL.createObjectURL(video.blob) : null,
    videoBlob: video?.blob ?? null,
    videoMime: video?.mimeType ?? null,
    videoOffsetMs: video?.offsetMs ?? 0,
    audioUrl: audioBlob && typeof URL !== "undefined" ? URL.createObjectURL(audioBlob) : null,
    audioOffsetMs: micOffsetMs,
  };
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
  caseId?: string;
  orgId?: string;
}): UseRecordReplay {
  const { controls, overlay, ready } = opts;

  const [captureError, setCaptureError] = useState("");
  const [acknowledgedChunks, setAcknowledgedChunks] = useState(0);
  const [recoverable, setRecoverable] = useState<LocalCapture[]>([]);
  const [recoveredSessionId, setRecoveredSessionId] = useState("");
  const refreshRecovery = useCallback(async () => {
    if (!opts.caseId || !opts.orgId) return;
    try { setRecoverable((await captureLocalStore.list(opts.orgId, opts.caseId)).filter(c => !c.synced)); }
    catch { setCaptureError("Browser storage is unavailable. Capture cannot be retained until storage is enabled."); }
  }, [opts.caseId, opts.orgId]);
  useEffect(() => { void refreshRecovery(); }, [refreshRecovery]);
  const [phase, setPhase] = useState<RecordPhase>("idle");
  const [pendingMarkers, setPendingMarkers] = useState<JournalEntry[]>([]);
  const [micCapture, setMicCapture] = useState<"unknown" | "live" | "unavailable">("unknown");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [track, setTrack] = useState<RecordedTrack | null>(null);
  const [audio, setAudio] = useState<{ base64: string; mimeType: string } | null>(null);
  const [frames, setFrames] = useState<CompileFrame[]>([]);
  const [playback, setPlayback] = useState<TakePlayback>(EMPTY_PLAYBACK);
  const [progress, setProgress] = useState(0);
  const playbackRef = useRef<TakePlayback>(EMPTY_PLAYBACK);

  const startingRef = useRef<Promise<void>>(Promise.resolve());
  const recorderRef = useRef<TrackRecorder | JournalRecorder | null>(null);
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

    phaseRef.current = "starting";
    setPhase("starting"); setCaptureError(""); setAcknowledgedChunks(0); setRecoveredSessionId("");
    setTrack(null); setAudio(null); setPendingMarkers([]);
    const viewer = controls.current;
    if (opts.caseId && opts.orgId && (!viewer.onRendered || !viewer.requestView || !viewer.getRenderedView || !viewer.captureImagePoint)) {
      setCaptureError("The viewer is not ready for render-confirmed capture."); setPhase("idle"); phaseRef.current = "idle"; return false;
    }
    const rec = opts.caseId && opts.orgId ? new JournalRecorder({
      caseId: opts.caseId, orgId: opts.orgId, viewer: viewer as RenderConfirmedViewer,
      onPhase: next => { if (next !== "stopped" && phaseRef.current !== "stopping") { phaseRef.current = next; setPhase(next); } },
      onError: setCaptureError, onSync: setAcknowledgedChunks, onMarkers: setPendingMarkers,
    }) : new TrackRecorder();
    recorderRef.current = rec;
    framesRef.current = [];
    setFrames([]);
    releasePlayback(playbackRef.current);
    playbackRef.current = EMPTY_PLAYBACK;
    setPlayback(EMPTY_PLAYBACK);
    const priming = controls.current.getStartState();
    setMicCapture("unknown");
    let videoStream: MediaStream | null = null;
    try {
      videoStream = controls.current.captureViewportStream?.() ?? null;
    } catch {
      videoStream = null;
    }
    try { startingRef.current = rec.start(priming, { onMic: (state) => setMicCapture(state), videoStream }); await startingRef.current; }
    catch {
      videoStream?.getTracks().forEach(t => t.stop());
      setCaptureError("Capture could not start. Enable browser storage and microphone access, then retry.");
      setPhase("idle"); phaseRef.current = "idle"; recorderRef.current = null; return false;
    }
    if (["stopping"].includes(phaseRef.current)) return true;
    if (!(rec instanceof JournalRecorder)) { setPhase("recording"); phaseRef.current = "recording"; }
    setElapsedMs(0);
    elapsedTimerRef.current = setInterval(
      () => setElapsedMs(Math.round(rec.elapsedMs())),
      100
    );
    return true;
  }, [ready, controls, overlay, opts.caseId, opts.orgId]);

  const stopRecording = useCallback(async (): Promise<{
    track: RecordedTrack;
    audio: { base64: string; mimeType: string } | null;
    frames: CompileFrame[];
  } | null> => {
    const rec = recorderRef.current;
    if (!rec || !["starting", "recording"].includes(phaseRef.current)) return null;
    phaseRef.current = "stopping"; setPhase("stopping");
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
    const shot = readViewportStill(controls.current);
    if (shot) {
      framesRef.current = pushViewportStill(framesRef.current, {
        tMs: rec.elapsedMs(),
        mimeType: shot.mimeType,
        base64: shot.base64,
      });
    }
    let stopped;
    try { await startingRef.current; stopped = await rec.stop(); }
    catch {
      setCaptureError("Capture could not finish. Retained chunks remain available below; retry recovery.");
      setPhase("idle"); phaseRef.current = "idle"; recorderRef.current = null; await refreshRecovery(); return null;
    }
    const stills = framesRef.current;
    recorderRef.current = null;
    const nextPlayback = playbackFromStop(stopped.video, stopped.audio, stopped.micOffsetMs);
    playbackRef.current = nextPlayback;
    setPlayback(nextPlayback);
    setTrack(stopped.track);
    setAudio(stopped.audio);
    setFrames(stills);
    setPhase("idle"); phaseRef.current = "idle";
    await refreshRecovery();
    return { track: stopped.track, audio: stopped.audio, frames: stills };
  }, [controls, refreshRecovery]);

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
      if (!t || !controls.current || ["starting", "recording", "stopping"].includes(phaseRef.current)) return;
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
    releasePlayback(playbackRef.current);
    playbackRef.current = EMPTY_PLAYBACK;
    setPlayback(EMPTY_PLAYBACK);
    setTrack(null);
    setAudio(null);
    setFrames([]);
    setProgress(0);
    setMicCapture("unknown");
  }, [stopReplay]);

  // Viewport stills share the recorder clock for the whole take. A failed
  // grab is ignored — the track and audio still save.
  useEffect(() => {
    if (phase !== "recording" && phase !== "starting") return;
    const sample = () => {
      const rec = recorderRef.current;
      if (!rec?.isRecording) return;
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
  }, [phase, controls]);

  // --- Alt+X hold-to-record hotkey -----------------------------------------
  useEffect(() => {
    let held = false;
    const onKeyDown = (e: KeyboardEvent) => {
      const action = studioHotkey(e);
      if (!action) return;
      if (action === "undo-marker") {
        if (recorderRef.current instanceof JournalRecorder && recorderRef.current.isRecording) { e.preventDefault(); recorderRef.current.undoMarker(); }
        return;
      }
      if (phaseRef.current === "idle") { e.preventDefault(); held = true; void startRecording(); }
    };
    const release = () => {
      if (!held) return;
      held = false;
      if (["starting", "recording"].includes(phaseRef.current)) void stopRecording();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (held && (e.code === "KeyX" || e.key.toLowerCase() === "x" || e.key === "Alt")) { e.preventDefault(); release(); }
    };
    window.addEventListener("blur", release);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("blur", release);
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

  const onMarker = useCallback((x: number, y: number) => {
    const recorder = recorderRef.current;
    if (recorder instanceof JournalRecorder) recorder.marker(x, y);
  }, []);
  const removeMarker = useCallback((id: string) => { if (recorderRef.current instanceof JournalRecorder) recorderRef.current.removeMarker(id); }, []);
  const undoMarker = useCallback(() => { if (recorderRef.current instanceof JournalRecorder) recorderRef.current.undoMarker(); }, []);
  const recover = useCallback(async (sessionId: string) => {
    if (phaseRef.current !== "idle") return;
    setCaptureError(""); phaseRef.current = "stopping"; setPhase("stopping");
    try {
      const local = await captureLocalStore.get(sessionId);
      if (!local || local.orgId !== opts.orgId || local.manifest.caseId !== opts.caseId) throw new Error("Capture unavailable");
      const recovered = await recoverCapture(local);
      const chunks = await captureLocalStore.chunks(sessionId);
      const audioChunks = chunks.filter(c => c.chunk.stream === "audio");
      const videoChunks = chunks.filter(c => c.chunk.stream === "video");
      const audioBlob = audioChunks.length ? new Blob(audioChunks.map(c => c.blob), { type: audioChunks[0].chunk.mime }) : null;
      const audioData = audioBlob ? { base64: await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(audioBlob);
      }), mimeType: audioBlob.type } : null;
      const video = videoChunks.length ? { blob: new Blob(videoChunks.map(c => c.blob), { type: videoChunks[0].chunk.mime }), mimeType: videoChunks[0].chunk.mime, offsetMs: recovered.manifest.offsets.video ?? 0 } : null;
      releasePlayback(playbackRef.current);
      const nextPlayback = playbackFromStop(video, audioData, recovered.manifest.offsets.audio ?? 0);
      playbackRef.current = nextPlayback; setPlayback(nextPlayback);
      setTrack(recovered.track ?? null); setAudio(audioData); setFrames([]); setRecoveredSessionId(sessionId);
      setAcknowledgedChunks(recovered.manifest.chunks.length);
      await refreshRecovery();
    } catch (error) { setCaptureError(error instanceof Error ? error.message : "Recovery failed; retained data was kept. Retry when connected."); }
    finally { phaseRef.current = "idle"; setPhase("idle"); }
  }, [opts.orgId, opts.caseId, refreshRecovery]);

  const reviewMedia = useCallback(async () => {
    if (!track?.captureSessionId || !opts.caseId) return;
    try {
      const res = await fetch(`${captureBase(opts.caseId, track.captureSessionId)}/manifest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "review", review: { pixels: true, audio: true, screen: true } }) });
      const manifest = await res.json();
      if (!res.ok) throw new Error(manifest.error || "Complete server sync before reviewing media.");
      const local = await captureLocalStore.get(track.captureSessionId);
      if (local) { local.manifest = manifest; await captureLocalStore.save(local); }
      setTrack(previous => previous ? { ...previous, mediaManifest: manifest } : previous);
      setCaptureError("");
    } catch (error) { setCaptureError(error instanceof Error ? error.message : "Media review could not be saved. Retry."); }
  }, [track, opts.caseId]);

  // Cleanup.
  useEffect(
    () => () => {
      if (recorderRef.current?.isRecording) void recorderRef.current.stop().catch(() => {});
      replayRef.current?.cancel();
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      audioElRef.current?.pause();
      releasePlayback(playbackRef.current);
    },
    []
  );

  return {
    pendingMarkers, removeMarker, undoMarker, phase, mediaReviewed: Boolean(track?.mediaManifest?.phiReview.pixels && track.mediaManifest.phiReview.audio && track.mediaManifest.phiReview.screen), reviewMedia, captureError, acknowledgedChunks, recoverable, recoveredSessionId, recover, onMarker,
    supported,
    micCapture,
    elapsedMs,
    track,
    audio,
    frames,
    playback,
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
