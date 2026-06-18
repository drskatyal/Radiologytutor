"use client";

// The student session state machine. Owns: the ordered finding walk-through,
// the viewer drive handle, the chat transcript, and the EXACT two-call voice
// flow from CLAUDE.md §2:
//
//   press mic → capture audio
//   → CALL 1  POST /api/transcribe   (Gemini STT)
//   → render the user's transcript as a chat turn IMMEDIATELY
//   → CALL 2  POST /api/tutor        (teaching plan: answer + viewer action)
//   → render the tutor's answer as a chat turn
//   → speak it via /api/tts
//
// The two calls are never merged. Typed questions skip call 1 and go straight
// to call 2. Tutor answers can drive the viewer (show_finding / next / prev /
// set_window). The student can ask at any step without losing their place.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecorder } from "@/components/useRecorder";
import { useToast, type MicState } from "@/components/ui";
import { speak, stopSpeaking } from "@/lib/speak";
import { findingViewerState } from "@/lib/viewerController";
import { startReplay, type ReplayController } from "@/lib/replay";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ReplayOverlayHandle } from "@/components/ReplayOverlay";
import type { CaseData, Marker } from "@/lib/types";

export type SessionMode = "guided" | "socratic" | "free" | "reporting";

/** A web source cited by the tutor (from Google Search grounding). */
export interface ChatSource {
  title: string;
  url: string;
}

/** What the session is doing right now (drives the status UI). */
export type SessionPhase =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** A spoken (voice) user turn. */
  voice?: boolean;
  /** A user turn whose transcript hasn't arrived yet. */
  pending?: boolean;
  /** An assistant turn that is an error message. */
  error?: boolean;
  /** Web sources the tutor cited (assistant turns; from grounding). */
  sources?: ChatSource[];
}

interface ViewerAction {
  type: "show_finding" | "next_in_tour" | "prev_in_tour" | "set_window" | "none";
  findingId?: string;
  windowWidth?: number;
  windowCenter?: number;
}

let turnSeq = 0;
const nextId = () => `t${Date.now().toString(36)}_${turnSeq++}`;

export function useStudentSession(caseData: CaseData, mode: SessionMode) {
  const { toast } = useToast();
  const recorder = useRecorder();

  const controls = useRef<CornerstoneControls | null>(null);
  const overlay = useRef<ReplayOverlayHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The currently-running finding replay (recorded track), if any.
  const replayRef = useRef<ReplayController | null>(null);
  const replayAudioRef = useRef<HTMLAudioElement | null>(null);

  const [ready, setReady] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [marker, setMarker] = useState<Marker | null>(null);
  const [markerVisible, setMarkerVisible] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  // Mirror of `turns` so side-effecting handlers can read history without
  // running effects inside a setState updater (StrictMode-safe).
  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;

  const orderedFindings = useMemo(
    () => caseData.findings.slice().sort((a, b) => a.order - b.order),
    [caseData]
  );
  const activeIndexRef = useRef(-1);
  activeIndexRef.current = activeIndex;

  const busy = phase === "transcribing" || phase === "thinking";

  const micState: MicState =
    phase === "recording" ? "recording" : phase === "transcribing" ? "processing" : "idle";

  // --- Viewer ready ---------------------------------------------------------
  const onViewerReady = useCallback((c: CornerstoneControls) => {
    controls.current = c;
    setReady(true);
  }, []);

  // Stop any in-flight finding replay (track retrace + its narration audio).
  const stopReplay = useCallback(() => {
    replayRef.current?.cancel();
    replayRef.current = null;
    if (replayAudioRef.current) {
      replayAudioRef.current.pause();
      replayAudioRef.current = null;
    }
    overlay.current?.clear();
    setReplaying(false);
  }, []);

  // --- Drive the viewer to a finding ---------------------------------------
  // If the finding has a recorded `track`, replay it EXACTLY (retrace + laser
  // pointer overlay + the teacher's recorded narration audio). Otherwise fall
  // back to the smooth showState animation to the finding's static view.
  const revealFinding = useCallback(
    async (index: number) => {
      const finding = orderedFindings[index];
      if (!finding || !controls.current) return;
      stopReplay();
      setMarkerVisible(false);

      const track = finding.track;
      if (track && track.events.length > 0) {
        setActiveIndex(index);
        // The recorded marker is part of the retrace, so hold the static marker.
        setMarker(null);

        let audioEl: HTMLAudioElement | null = null;
        if (track.audioUrl) {
          audioEl = new Audio(track.audioUrl);
          replayAudioRef.current = audioEl;
          audioEl.play().catch(() => {});
        }

        setReplaying(true);
        replayRef.current = startReplay(
          track,
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
            onEnd: () => {
              replayAudioRef.current = null;
              setReplaying(false);
              // Land on the static marker so the finding stays highlighted.
              setMarker(finding.marker ?? null);
              setMarkerVisible(true);
            },
          }
        );
        return;
      }

      // No track: spread findings across the stack by tour order as a slice
      // hint, then refine from the finding's recorded camera/VOI when available.
      const total = Math.max(1, orderedFindings.length);
      const sliceHint = total > 1 ? index / (total - 1) : 0.5;
      const view = (await findingViewerState(finding, sliceHint)) ?? { sliceFraction: sliceHint };

      await controls.current.showState(view, 750);
      setActiveIndex(index);
      setMarker(finding.marker ?? null);
      setMarkerVisible(true);
    },
    [orderedFindings, stopReplay]
  );

  // --- Execute a tutor viewer action ---------------------------------------
  const executeAction = useCallback(
    async (action: ViewerAction) => {
      const cur = activeIndexRef.current;
      switch (action.type) {
        case "show_finding": {
          const idx = orderedFindings.findIndex((f) => f.id === action.findingId);
          if (idx >= 0) await revealFinding(idx);
          break;
        }
        case "next_in_tour":
          await revealFinding(Math.min(cur + 1, orderedFindings.length - 1));
          break;
        case "prev_in_tour":
          await revealFinding(Math.max(cur - 1, 0));
          break;
        case "set_window":
          if (action.windowWidth != null && action.windowCenter != null) {
            controls.current?.setWindow(action.windowWidth, action.windowCenter);
          }
          break;
      }
    },
    [orderedFindings, revealFinding]
  );

  // --- CALL 2: teaching plan (text question -> answer + action) ------------
  const runTutor = useCallback(
    async (question: string, history: ChatTurn[]) => {
      setPhase("thinking");
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/tutor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
            caseId: caseData.caseId,
            mode,
            question,
            messages: history.map((t) => ({ role: t.role, text: t.text })),
            currentFindingId:
              activeIndexRef.current >= 0
                ? orderedFindings[activeIndexRef.current]?.id
                : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Tutor error");

        if (data.action && data.action.type !== "none") {
          await executeAction(data.action as ViewerAction);
        }

        const answer = String(data.answer ?? "").trim();
        const sources: ChatSource[] = Array.isArray(data.sources)
          ? (data.sources as ChatSource[])
              .filter((s) => s && typeof s.url === "string" && s.url)
              .map((s) => ({ url: s.url, title: s.title || s.url }))
          : [];
        if (answer) {
          setTurns((prev) => [
            ...prev,
            { id: nextId(), role: "assistant", text: answer, sources },
          ]);
          setPhase("speaking");
          speak(answer, () => setPhase((p) => (p === "speaking" ? "idle" : p)));
        } else {
          setPhase("idle");
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "Tutor error";
        setTurns((prev) => [...prev, { id: nextId(), role: "assistant", text: msg, error: true }]);
        toast({ title: "Tutor unavailable", description: msg, variant: "danger" });
        setPhase("idle");
      }
    },
    [caseData.caseId, mode, orderedFindings, executeAction, toast]
  );

  // --- Typed question: straight to CALL 2 ----------------------------------
  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      stopSpeaking();
      stopReplay();
      const history = turnsRef.current;
      setTurns((prev) => [...prev, { id: nextId(), role: "user", text: trimmed }]);
      runTutor(trimmed, history);
    },
    [busy, runTutor, stopReplay]
  );

  // --- Voice question: CALL 1 (transcribe) then CALL 2 (tutor) -------------
  const onMicStart = useCallback(async () => {
    if (busy) return;
    stopSpeaking();
    stopReplay();
    try {
      await recorder.start();
      setPhase("recording");
    } catch {
      toast({ title: "Microphone blocked", description: "Allow mic access to ask by voice.", variant: "warning" });
    }
  }, [busy, recorder, toast, stopReplay]);

  const onMicStop = useCallback(async () => {
    const rec = await recorder.stop();
    if (!rec) {
      setPhase("idle");
      return;
    }

    // Render a pending user turn immediately, fill it with the transcript.
    const pendingId = nextId();
    setTurns((prev) => [...prev, { id: pendingId, role: "user", text: "", voice: true, pending: true }]);
    setPhase("transcribing");

    try {
      // CALL 1 — transcription only.
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: { base64: rec.base64, mime: rec.mimeType } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transcription failed");

      const transcript = String(data.transcript ?? "").trim();
      if (!transcript) {
        setTurns((prev) => prev.filter((t) => t.id !== pendingId));
        toast({ title: "Didn't catch that", description: "No speech detected — try again.", variant: "warning" });
        setPhase("idle");
        return;
      }

      // Resolve the user's transcript turn, then CALL 2 with prior history
      // (everything before this voice turn).
      const history = turnsRef.current.filter((t) => t.id !== pendingId);
      setTurns((prev) =>
        prev.map((t) => (t.id === pendingId ? { ...t, text: transcript, pending: false } : t))
      );
      runTutor(transcript, history);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transcription failed";
      setTurns((prev) => prev.filter((t) => t.id !== pendingId));
      toast({ title: "Voice unavailable", description: msg, variant: "danger" });
      setPhase("idle");
    }
  }, [recorder, runTutor, toast]);

  // --- Tour controls (step rail) -------------------------------------------
  const goTo = useCallback(
    (index: number) => {
      if (busy || !ready) return;
      stopSpeaking();
      stopReplay();
      revealFinding(index);
    },
    [busy, ready, revealFinding, stopReplay]
  );
  const next = useCallback(() => goTo(Math.min(activeIndexRef.current + 1, orderedFindings.length - 1)), [goTo, orderedFindings.length]);
  const prev = useCallback(() => goTo(Math.max(activeIndexRef.current - 1, 0)), [goTo]);

  const onStopSpeaking = useCallback(() => {
    if (phase === "speaking") {
      stopSpeaking();
      setPhase("idle");
    }
  }, [phase]);

  // Auto-open the first finding once the viewer is ready (guided start).
  useEffect(() => {
    if (ready && activeIndexRef.current === -1 && orderedFindings.length > 0) {
      revealFinding(0);
    }
  }, [ready, orderedFindings.length, revealFinding]);

  // Cleanup: stop audio/replay + abort any in-flight tutor call on unmount.
  useEffect(
    () => () => {
      stopSpeaking();
      replayRef.current?.cancel();
      replayAudioRef.current?.pause();
      abortRef.current?.abort();
    },
    []
  );

  return {
    controls,
    overlay,
    ready,
    replaying,
    activeIndex,
    marker,
    markerVisible,
    turns,
    phase,
    busy,
    micState,
    micSupported: recorder.supported,
    orderedFindings,
    onViewerReady,
    sendText,
    onMicStart,
    onMicStop,
    onStopSpeaking,
    next,
    prev,
    goTo,
  };
}
