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

/** The agent orb's visible mood (mirrors AgentOrb's OrbState). */
export type OrbState = "idle" | "listening" | "thinking" | "searching" | "speaking";

// Cues that suggest the tutor will reach for the web (Google Search grounding).
// We can't know grounding is happening until sources come back (the /api/tutor
// call isn't streamed), so we light the "searching" orb when the question reads
// like it needs outside evidence. See the API wish in the PR notes.
const WEB_CUES =
  /\b(latest|recent|guideline|guidelines|evidence|study|studies|research|literature|paper|trial|recommend|recommended|statistic|prevalence|incidence|criteria|classification|acr|fleischner|bi-?rads|lung-?rads|society|consensus|published)\b/i;

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
  type:
    | "show_finding"
    | "next_in_tour"
    | "prev_in_tour"
    | "set_window"
    | "point_to"
    | "none";
  findingId?: string;
  windowWidth?: number;
  windowCenter?: number;
  x_pct?: number;
  y_pct?: number;
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
  /** True while the AI laser is tweening to a marker (no recorded track). */
  const [pointing, setPointing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [marker, setMarker] = useState<Marker | null>(null);
  const [markerVisible, setMarkerVisible] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  // True while a "thinking" turn looks like it's reaching for the web — drives
  // the orb's distinct "searching" animation (see WEB_CUES above).
  const [searching, setSearching] = useState(false);
  // A gentle synthetic input level (0..1) while recording, so the orb's mic
  // rings feel alive. We avoid a second getUserMedia/AnalyserNode (the recorder
  // owns the stream); this is a rhythmic affordance, not a true VU meter.
  const [micLevel, setMicLevel] = useState(0);
  // The turn whose voice is currently being (re)played, for the ▶ control.
  const [speakingTurnId, setSpeakingTurnId] = useState<string | null>(null);
  // false once any AI call returns 503 (GEMINI_API_KEY missing) — lets the UI
  // show a friendly, honest limitation without guessing server config.
  const [aiAvailable, setAiAvailable] = useState(true);
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

  // The single source of truth for the agent orb's mood.
  const orbState: OrbState =
    phase === "recording"
      ? "listening"
      : phase === "transcribing"
        ? "thinking"
        : phase === "thinking"
          ? searching
            ? "searching"
            : "thinking"
          : phase === "speaking"
            ? "speaking"
            : "idle";

  // Drive the synthetic mic level while recording; settle to 0 otherwise.
  useEffect(() => {
    if (phase !== "recording") {
      setMicLevel(0);
      return;
    }
    let raf = 0;
    let t = 0;
    const tick = () => {
      t += 0.18;
      // Layered sines + a little jitter → an organic, never-flat pulse.
      const base = 0.45 + 0.35 * Math.abs(Math.sin(t)) + 0.18 * Math.sin(t * 2.7);
      setMicLevel(Math.max(0, Math.min(1, base + (Math.random() - 0.5) * 0.12)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

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
    setPointing(false);
  }, []);

  /** Animate the laser to a normalized point, then optionally land a marker. */
  const pointLaser = useCallback(async (x: number, y: number, landMarker?: Marker) => {
    if (!overlay.current?.animateTo) return;
    setPointing(true);
    setMarkerVisible(false);
    try {
      await overlay.current.animateTo(x, y, { durationMs: 900 });
      if (landMarker) {
        setMarker(landMarker);
        setMarkerVisible(true);
      }
    } finally {
      setPointing(false);
    }
  }, []);

  // --- Drive the viewer to a finding ---------------------------------------
  // If the finding has a recorded `track`, replay it EXACTLY (retrace + laser
  // pointer overlay + the teacher's recorded narration audio). Otherwise fall
  // back to the smooth showState animation, then tween the AI laser to the
  // author's click marker.
  const revealFinding = useCallback(
    async (index: number) => {
      const finding = orderedFindings[index];
      if (!finding || !controls.current) return;
      stopReplay();
      setMarkerVisible(false);

      // Multi-series: if this finding is anchored to a specific series, switch
      // the viewport (and the navigator, via onSeriesChange) to it before we
      // drive the view. A recorded track that captured its own `series` events
      // will still retrace exactly; this just primes anchored static findings.
      if (
        finding.seriesInstanceUID &&
        controls.current.seriesUIDs.includes(finding.seriesInstanceUID) &&
        controls.current.activeSeriesUID !== finding.seriesInstanceUID
      ) {
        controls.current.showSeries(finding.seriesInstanceUID);
      }

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
      const m = finding.marker ?? null;
      if (m && Number.isFinite(m.x_pct) && Number.isFinite(m.y_pct)) {
        await pointLaser(m.x_pct, m.y_pct, m);
      } else {
        setMarker(m);
        setMarkerVisible(true);
      }
    },
    [orderedFindings, stopReplay, pointLaser]
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
        case "point_to": {
          let x = action.x_pct;
          let y = action.y_pct;
          let land: Marker | undefined;
          if (action.findingId) {
            const f = orderedFindings.find((item) => item.id === action.findingId);
            if (f?.marker) {
              x = f.marker.x_pct;
              y = f.marker.y_pct;
              land = f.marker;
              const idx = orderedFindings.indexOf(f);
              if (idx >= 0 && idx !== activeIndexRef.current) {
                await revealFinding(idx);
                return;
              }
            }
          }
          if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) {
            await pointLaser(x, y, land);
          }
          break;
        }
      }
    },
    [orderedFindings, revealFinding, pointLaser]
  );

  // --- CALL 2: teaching plan (text question -> answer + action) ------------
  const runTutor = useCallback(
    async (question: string, history: ChatTurn[]) => {
      setPhase("thinking");
      // Light the "searching" orb up front when the question reads like it
      // needs outside evidence; sources arriving below confirm it after.
      setSearching(WEB_CUES.test(question));
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
        if (!res.ok) {
          // 503 means GEMINI_API_KEY isn't set — surface it as a friendly,
          // persistent limitation rather than a transient error toast.
          if (res.status === 503) setAiAvailable(false);
          throw new Error(data.error || "Tutor error");
        }
        setAiAvailable(true);

        if (data.action && data.action.type !== "none") {
          await executeAction(data.action as ViewerAction);
        }

        const answer = String(data.answer ?? "").trim();
        const sources: ChatSource[] = Array.isArray(data.sources)
          ? (data.sources as ChatSource[])
              .filter((s) => s && typeof s.url === "string" && s.url)
              .map((s) => ({ url: s.url, title: s.title || s.url }))
          : [];
        setSearching(false);
        if (answer) {
          const id = nextId();
          setTurns((prev) => [
            ...prev,
            { id, role: "assistant", text: answer, sources },
          ]);
          setPhase("speaking");
          setSpeakingTurnId(id);
          speak(answer, () => {
            setSpeakingTurnId((cur) => (cur === id ? null : cur));
            setPhase((p) => (p === "speaking" ? "idle" : p));
          });
        } else {
          setPhase("idle");
        }
      } catch (e) {
        setSearching(false);
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
      if (!res.ok) {
        if (res.status === 503) setAiAvailable(false);
        throw new Error(data.error || "Transcription failed");
      }

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
      setSpeakingTurnId(null);
      setPhase("idle");
    }
  }, [phase]);

  // Replay (or stop replaying) a tutor turn's voice on demand — the ▶ control
  // on assistant bubbles. Re-speaking interrupts any current speech (barge-in).
  const replayTurn = useCallback(
    (turn: ChatTurn) => {
      if (turn.role !== "assistant" || turn.error || !turn.text) return;
      // Toggle off if this exact turn is the one currently speaking.
      if (speakingTurnId === turn.id) {
        stopSpeaking();
        setSpeakingTurnId(null);
        if (phase === "speaking") setPhase("idle");
        return;
      }
      stopSpeaking();
      stopReplay();
      setPhase("speaking");
      setSpeakingTurnId(turn.id);
      speak(turn.text, () => {
        setSpeakingTurnId((cur) => (cur === turn.id ? null : cur));
        setPhase((p) => (p === "speaking" ? "idle" : p));
      });
    },
    [speakingTurnId, phase, stopReplay]
  );

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
    pointing,
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
    // Agent-orb + premium chat surface state.
    orbState,
    micLevel,
    searching,
    speakingTurnId,
    aiAvailable,
    replayTurn,
  };
}
