"use client";

// The student session state machine. Owns: the ordered finding walk-through,
// the viewer drive handle, the chat transcript, and the EXACT two-call voice
// flow from CLAUDE.md §2.
//
// Product: an AI attending teaches a registrar how to REPORT the scan — armed
// with authored findings + reading digests — driving the viewer while speaking.
// Teach mode (guided) plays a cleaned teaching guide when the finding has one
// (scroll, window, zoom, laser, strokes). Authored say lines go through
// speak(); a motion guide with none uses tutorSpeechPlan. Otherwise it asks
// the model to teach. An empty tutor answer advances the tour. Student
// voice/text pauses the tour.
// Viva is the oral-exam path. The dense track is not played as a mic tape.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecorder } from "@/components/useRecorder";
import { useToast, type MicState } from "@/components/ui";
import { speak, speakBeats, stopSpeaking } from "@/lib/speak";
import {
  buildPerformancePlan,
  normalizeTutorActions,
  splitSentences,
} from "@/lib/performancePlan";
import {
  NARRATION_HOLD_MAX_MS,
  tutorSpeechPlan,
  type SpokenFindingSource,
} from "@/lib/tutorSpeech";
import { findingViewerState } from "@/lib/viewerController";
import { playTeachingGuide, type ReplayController } from "@/lib/replay";
import type { HarnessViewerAction } from "@/lib/harness/tools";
import {
  authoredGuideLines,
  guideHasMotion,
  measurementsFromGuide,
  resolveTeachingGuide,
} from "@/lib/teachingGuide";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ReplayOverlayHandle } from "@/components/ReplayOverlay";
import type { CaseData, Finding, FindingMeasurement, Marker, TeachingGuide } from "@/lib/types";
import type { CaseSeries } from "@/lib/viewerSource";
import { examFallbackStem } from "@/lib/teachingPrompt";
import { clickHitsFinding } from "@/lib/clickFinding";
import { nextGuidedIndex } from "@/lib/tourAdapt";
import {
  secondaryAnchor,
  seriesIndexFor,
  wantsCompare,
} from "@/lib/findingAnchors";

export type SessionMode = "guided" | "socratic" | "free" | "reporting" | "viva";

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

type ViewerAction = HarnessViewerAction;

function spokenSources(findings: Finding[]): SpokenFindingSource[] {
  return findings.map((finding) => ({
    id: finding.id,
    label: finding.label,
    description: finding.description,
    teachingPoints: finding.teachingPoints,
    order: finding.order,
  }));
}

let turnSeq = 0;
const nextId = () => `t${Date.now().toString(36)}_${turnSeq++}`;

export function useStudentSession(
  caseData: CaseData,
  mode: SessionMode,
  series: CaseSeries[] = [],
  opts?: { courseId?: string | null }
) {
  const courseId = opts?.courseId?.trim() || null;
  const { toast } = useToast();
  const recorder = useRecorder();

  const controls = useRef<CornerstoneControls | null>(null);
  const overlay = useRef<ReplayOverlayHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Author QA replay only — student product does not VCR-play tracks.
  const replayRef = useRef<ReplayController | null>(null);
  const replayAudioRef = useRef<HTMLAudioElement | null>(null);
  /** Autonomous Teach tour: continue after TTS until paused or finished. */
  const tourActiveRef = useRef(false);
  /**
   * Bumped each time a guided step starts or the tour is paused. A late
   * speech callback from the previous finding must not start the one after.
   */
  const tourGenRef = useRef(0);
  /** play_guide is the only speech on this turn — speak its beats. */
  const narrateGuideRef = useRef(false);
  const runTutorRef = useRef<(q: string, h: ChatTurn[]) => Promise<void>>(
    async () => {}
  );
  const runGuidedRef = useRef<(index: number) => Promise<void>>(async () => {});
  const finishTourRef = useRef<() => void>(() => {});

  const [ready, setReady] = useState(false);
  const [replaying, setReplaying] = useState(false);
  /** True while the AI laser is tweening to a marker (no recorded track). */
  const [pointing, setPointing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [marker, setMarker] = useState<Marker | null>(null);
  const [markerVisible, setMarkerVisible] = useState(false);
  const [measurements, setMeasurements] = useState<FindingMeasurement[]>([]);
  const [measurementsVisible, setMeasurementsVisible] = useState(false);
  /** Teach-mode autonomous tour is running (false after student interrupt). */
  const [tourActive, setTourActive] = useState(false);
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
  /** Findings whose diagnosis/marker the student has been shown. */
  const [revealedIds, setRevealedIds] = useState<string[]>([]);
  const examMode = mode === "viva" || mode === "socratic";
  const secondaryControls = useRef<CornerstoneControls | null>(null);
  const secondaryOverlay = useRef<ReplayOverlayHandle | null>(null);
  const [secondaryReady, setSecondaryReady] = useState(false);
  const [secondaryMarker, setSecondaryMarker] = useState<Marker | null>(null);
  const [secondaryMarkerVisible, setSecondaryMarkerVisible] = useState(false);
  const [secondarySeriesIndex, setSecondarySeriesIndex] = useState(0);
  const [compareOpen, setCompareOpen] = useState(false);
  const [locateHint, setLocateHint] = useState("");
  const locateMissesRef = useRef(0);
  const [locatedIds, setLocatedIds] = useState<string[]>([]);
  const [helpedIds, setHelpedIds] = useState<string[]>([]);
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
  const startedRef = useRef(false);

  const markRevealed = useCallback((id: string) => {
    setRevealedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const onSecondaryReady = useCallback((c: CornerstoneControls) => {
    secondaryControls.current = c;
    setSecondaryReady(true);
  }, []);

  /** Finding waiting for the compare pane's first ready callback. */
  const pendingSecondaryRef = useRef<{
    finding: (typeof orderedFindings)[number];
    spoil: boolean;
  } | null>(null);

  const seatSecondary = useCallback(
    async (finding: (typeof orderedFindings)[number], spoil: boolean) => {
      const sec = secondaryAnchor(finding);
      if (!sec || !wantsCompare(finding)) {
        pendingSecondaryRef.current = null;
        setSecondaryMarker(null);
        setSecondaryMarkerVisible(false);
        return;
      }
      setCompareOpen(true);
      const idx = seriesIndexFor(series, sec.seriesInstanceUID);
      setSecondarySeriesIndex(idx);
      const c = secondaryControls.current;
      if (!c) {
        // Pane not mounted yet — reseat when secondaryReady flips true.
        pendingSecondaryRef.current = { finding, spoil };
        setSecondaryMarker(sec.marker ?? null);
        setSecondaryMarkerVisible(spoil);
        return;
      }
      pendingSecondaryRef.current = null;
      if (
        sec.seriesInstanceUID &&
        c.seriesUIDs.includes(sec.seriesInstanceUID) &&
        c.activeSeriesUID !== sec.seriesInstanceUID
      ) {
        c.showSeries(sec.seriesInstanceUID);
      }
      if (sec.sliceIndex != null && Number.isFinite(sec.sliceIndex)) {
        await c.showState({ sliceIndex: sec.sliceIndex }, 500);
      }
      setSecondaryMarker(sec.marker ?? null);
      setSecondaryMarkerVisible(spoil);
    },
    [series]
  );

  useEffect(() => {
    if (!secondaryReady || !pendingSecondaryRef.current) return;
    const pending = pendingSecondaryRef.current;
    pendingSecondaryRef.current = null;
    void seatSecondary(pending.finding, pending.spoil);
  }, [secondaryReady, seatSecondary]);

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
    controls.current?.clearAnnotations?.();
    setReplaying(false);
    setPointing(false);
  }, []);

  const pauseTour = useCallback(() => {
    tourGenRef.current += 1;
    tourActiveRef.current = false;
    setTourActive(false);
    replayRef.current?.cancel();
  }, []);

  /** Animate the laser to a normalized point, then optionally land a marker. */
  const pointLaser = useCallback(async (x: number, y: number, landMarker?: Marker) => {
    if (!overlay.current?.animateTo) return;
    const nx = Number.isFinite(x) ? x : 0.5;
    const ny = Number.isFinite(y) ? y : 0.5;
    setPointing(true);
    setMarkerVisible(false);
    try {
      await overlay.current.animateTo(nx, ny, { durationMs: 900 });
      if (landMarker) {
        setMarker(landMarker);
        setMarkerVisible(true);
      }
    } finally {
      setPointing(false);
    }
  }, []);

  // --- Drive the viewer to a finding ---------------------------------------
  // Student product: land on authored slice/VOI/marker/measurements and let the
  // AI tutor teach. Recorded tracks arm the model (readingDigest in the tutor
  // prompt) — we do NOT VCR-replay the teacher's mic + event tape here.
  // Author Studio still uses lib/replay for capture QA.
  const revealFinding = useCallback(
    async (index: number, opts?: { spoil?: boolean }) => {
      const finding = orderedFindings[index];
      if (!finding || !controls.current) return;
      const spoil = opts?.spoil !== false;
      stopReplay();
      setMarkerVisible(false);
      setMeasurementsVisible(false);
      setLocateHint("");
      locateMissesRef.current = 0;

      // Multi-series: if this finding is anchored to a specific series, switch
      // the viewport (and the navigator, via onSeriesChange) to it before we
      // drive the view.
      if (
        finding.seriesInstanceUID &&
        controls.current.seriesUIDs.includes(finding.seriesInstanceUID) &&
        controls.current.activeSeriesUID !== finding.seriesInstanceUID
      ) {
        controls.current.showSeries(finding.seriesInstanceUID);
      }

      // Prefer authored slice + VOI. Track digests inform the tutor; they are
      // not a student-facing cassette.
      const total = Math.max(1, orderedFindings.length);
      const sliceHint = total > 1 ? index / (total - 1) : 0.5;
      let view =
        (await findingViewerState(finding, sliceHint)) ?? { sliceFraction: sliceHint };
      if (finding.sliceIndex != null && Number.isFinite(finding.sliceIndex)) {
        view = { ...view, sliceIndex: finding.sliceIndex };
      }
      // Authored WW/WC always win — lung nodule must re-window even if Pacsbin
      // state was empty / student is on bone.
      if (
        finding.windowWidth != null &&
        finding.windowCenter != null &&
        Number.isFinite(finding.windowWidth) &&
        Number.isFinite(finding.windowCenter)
      ) {
        view = {
          ...view,
          windowWidth: finding.windowWidth,
          windowCenter: finding.windowCenter,
        };
      }

      await controls.current.showState(view, 750);
      setActiveIndex(index);
      const m = finding.marker ?? null;
      const meas = finding.measurements ?? [];
      setMeasurements(meas);
      if (spoil && m && Number.isFinite(m.x_pct) && Number.isFinite(m.y_pct)) {
        markRevealed(finding.id);
        await pointLaser(m.x_pct, m.y_pct, m);
        setMeasurementsVisible(meas.length > 0);
      } else {
        setMarker(m);
        setMarkerVisible(false);
        setMeasurementsVisible(spoil && meas.length > 0);
      }
      await seatSecondary(finding, spoil);
    },
    [orderedFindings, stopReplay, pointLaser, markRevealed, seatSecondary]
  );

  // --- Play a cleaned teach script (learner clock, not the mic tape) ------
  const playFindingGuide = useCallback(
    async (
      finding: Finding,
      guide: TeachingGuide,
      opts?: { narrate?: (text: string) => Promise<void> }
    ) => {
      if (!controls.current) return;
      stopReplay();
      setMarkerVisible(false);
      setMeasurementsVisible(false);
      setReplaying(true);
      const ctrl = playTeachingGuide(
        guide,
        {
          applyEvent: (e) => controls.current?.applyEvent(e),
          getSliceIndex: () => controls.current?.getStartState().sliceIndex ?? 0,
          settle: () => controls.current?.settle() ?? Promise.resolve(),
          setWindow: (ww, wc) => controls.current?.setWindow(ww, wc),
          showState: (state, ms) => controls.current?.showState(state, ms),
          annotationLanded: () => controls.current?.annotationApplied === true,
          overlay: {
            cursor: (x, y) => overlay.current?.cursor(x, y),
            annotation: (e) => overlay.current?.annotation(e),
            animateTo: (x, y, o) =>
              overlay.current?.animateTo(x, y, o) ?? Promise.resolve(),
            clear: () => overlay.current?.clear(),
          },
        },
        {
          narrate: opts?.narrate,
          // Hint only. The script's own say lines already go through narrate.
          // Do not fill this with tutorSpeech — guided mode would name the finding.
          landmark: finding.landmark,
          withholdTerms: finding.label ? [finding.label] : undefined,
        }
      );
      replayRef.current = ctrl;
      await ctrl.finished;
      if (replayRef.current === ctrl) {
        replayRef.current = null;
        setReplaying(false);
      }
    },
    [stopReplay]
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
            // Adaptive: scrolls when Δ is small, snaps bone↔lung when large.
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
        case "scroll_to": {
          if (
            action.seriesInstanceUID &&
            controls.current?.seriesUIDs.includes(action.seriesInstanceUID)
          ) {
            controls.current.showSeries(action.seriesInstanceUID);
            await controls.current.settle();
          }
          await controls.current?.showState({ sliceIndex: action.sliceIndex }, 520);
          break;
        }
        case "zoom_to":
        case "set_zoom": {
          const pan =
            action.panX != null && action.panY != null
              ? ([action.panX, action.panY] as [number, number])
              : undefined;
          await controls.current?.showState({ zoom: action.zoom, pan }, 520);
          break;
        }
        case "set_invert":
          controls.current?.applyEvent({ t: 0, type: "invert", value: action.value });
          break;
        case "draw_annotation": {
          const target = action.findingId
            ? orderedFindings.find((item) => item.id === action.findingId)
            : orderedFindings[activeIndexRef.current];
          const guide = target ? resolveTeachingGuide(target) : null;
          const strokes =
            guide?.beats.flatMap((b) => b.actions.filter((a) => a.type === "annotate")) ??
            [];
          if (strokes.length > 0) {
            for (const stroke of strokes) {
              const { type: _type, ...rest } = stroke;
              controls.current?.applyEvent({ t: 0, type: "annotation", ...rest });
            }
            await controls.current?.settle();
            if (controls.current && !controls.current.annotationApplied && target) {
              const meas = measurementsFromGuide(resolveTeachingGuide(target)!);
              if (meas.length) {
                setMeasurements(meas);
                setMeasurementsVisible(true);
              }
            }
            break;
          }
          if (
            action.x_pct != null &&
            action.y_pct != null &&
            Number.isFinite(action.x_pct) &&
            Number.isFinite(action.y_pct)
          ) {
            const x2 = action.x2_pct ?? action.x_pct;
            const y2 = action.y2_pct ?? action.y_pct;
            const event = {
              t: 0,
              type: "annotation" as const,
              shape: action.tool === "Length" || action.tool === "ArrowAnnotate" ? ("arrow" as const) : ("circle" as const),
              from: [action.x_pct, action.y_pct] as [number, number],
              to: [x2, y2] as [number, number],
              tool: action.tool,
              handles: [
                [action.x_pct, action.y_pct],
                [x2, y2],
              ] as Array<[number, number]>,
            };
            controls.current?.applyEvent(event);
            await controls.current?.settle();
            if (controls.current && !controls.current.annotationApplied) {
              overlay.current?.annotation(event);
            }
          }
          break;
        }
        case "play_guide": {
          const target =
            orderedFindings.find((item) => item.id === action.findingId) ??
            orderedFindings[activeIndexRef.current];
          if (!target) break;
          const idx = orderedFindings.indexOf(target);
          if (idx >= 0) setActiveIndex(idx);
          markRevealed(target.id);
          const guide = resolveTeachingGuide(target);
          if (guide && guideHasMotion(guide)) {
            // A live answer is already in speakBeats. Speaking the guide on
            // top would cancel that clip. Narrate only when this call is the
            // speech (a tool-only turn with nothing else to say).
            if (narrateGuideRef.current) {
              const turnId = nextId();
              setTurns((prev) => [...prev, { id: turnId, role: "assistant", text: "" }]);
              setPhase("speaking");
              setSpeakingTurnId(turnId);
              await playFindingGuide(target, guide, {
                narrate: async (text) => {
                  setTurns((prev) =>
                    prev.map((turn) =>
                      turn.id === turnId
                        ? { ...turn, text: turn.text ? `${turn.text} ${text}` : text }
                        : turn
                    )
                  );
                  await speak(text, undefined, { persona: "attending" });
                },
              });
              setSpeakingTurnId((cur) => (cur === turnId ? null : cur));
              setPhase((phase) => (phase === "speaking" ? "idle" : phase));
            } else {
              await playFindingGuide(target, guide);
            }
          } else if (idx >= 0) {
            await revealFinding(idx);
          }
          if (target.marker) {
            setMarker(target.marker);
            setMarkerVisible(true);
          }
          break;
        }
        default:
          break;
      }
    },
    [orderedFindings, revealFinding, pointLaser, playFindingGuide, markRevealed]
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
        const currentFindingId =
          activeIndexRef.current >= 0
            ? orderedFindings[activeIndexRef.current]?.id
            : undefined;
        const tourActive = mode === "guided" && tourActiveRef.current;

        // Teach advances only after speech ends. If there is nothing to say,
        // advance anyway — an empty clip must not hide Continue forever.
        const queueGuidedAdvance = () => {
          if (mode !== "guided" || !tourActiveRef.current) return;
          const cur = activeIndexRef.current;
          const atEnd = cur >= orderedFindings.length - 1;
          window.setTimeout(() => {
            if (abortRef.current?.signal.aborted) return;
            if (!tourActiveRef.current) return;
            if (atEnd) {
              finishTourRef.current();
              return;
            }
            void runGuidedRef.current(cur + 1);
          }, 1100);
        };

        const deliverSpeech = (
          text: string,
          speechActions: ViewerAction[],
          sources: ChatSource[]
        ) => {
          const plan = buildPerformancePlan(text, speechActions);
          const spoken = plan.filter((beat) => beat.text.trim());
          const lead = plan.filter((beat) => !beat.text.trim());
          for (const beat of lead) {
            for (const action of beat.actions) void executeAction(action);
          }
          if (spoken.length === 0) {
            setPhase("idle");
            queueGuidedAdvance();
            return;
          }
          const id = nextId();
          setTurns((prev) => [...prev, { id, role: "assistant", text: "", sources }]);
          setPhase("speaking");
          setSpeakingTurnId(id);
          void speakBeats(
            spoken.map((beat) => beat.text),
            {
              authorId: caseData.authorId,
              onStartBeat: (i) => {
                const soFar = spoken
                  .slice(0, i + 1)
                  .map((beat) => beat.text)
                  .join(" ");
                setTurns((prev) =>
                  prev.map((turn) => (turn.id === id ? { ...turn, text: soFar } : turn))
                );
                for (const action of spoken[i].actions) {
                  void executeAction(action);
                }
              },
              onEnd: () => {
                setSpeakingTurnId((cur) => (cur === id ? null : cur));
                setPhase((phase) => (phase === "speaking" ? "idle" : phase));
                queueGuidedAdvance();
              },
            }
          );
        };

        const priorTurns = history.map((turn) => ({ role: turn.role, text: turn.text }));

        if (!res.ok) {
          // 503 means GEMINI_API_KEY isn't set — still speak an authored line
          // (Teach) or the exam stem (viva) instead of a silent error toast.
          // A partial exam answer climbs the hint ladder instead of the stem.
          if (res.status === 503) {
            setAiAvailable(false);
            setSearching(false);
            const speech = tutorSpeechPlan({
              answer: "",
              actions: [],
              mode,
              question,
              findings: spokenSources(orderedFindings),
              currentFindingId,
              tourActive,
              viewerAlreadySeated: tourActive,
              history: priorTurns,
            });
            const line = speech.speak
              ? speech.answer
              : examMode
                ? examFallbackStem(orderedFindings.length)
                : "";
            if (line.trim()) {
              deliverSpeech(line, [], []);
              return;
            }
            setPhase("idle");
            if (speech.advanceWithoutSpeech) queueGuidedAdvance();
            return;
          }
          throw new Error(data.error || "Tutor error");
        }
        setAiAvailable(true);

        const opening = question === "Begin the session.";
        let actions = normalizeTutorActions(
          data as { action?: ViewerAction; actions?: ViewerAction[] }
        );
        // Opening a viva: we already seated the slice. Don't spoil the
        // marker just because the model called show_finding with the stem.
        if (examMode && opening) {
          actions = actions.filter((a) => a.type !== "show_finding");
        }

        const sources: ChatSource[] = Array.isArray(data.sources)
          ? (data.sources as ChatSource[])
              .filter((source) => source && typeof source.url === "string" && source.url)
              .map((source) => ({ url: source.url, title: source.title || source.url }))
          : [];
        setSearching(false);

        const speech = tutorSpeechPlan({
          answer: String(data.answer ?? ""),
          actions,
          mode,
          question,
          findings: spokenSources(orderedFindings),
          currentFindingId,
          tourActive,
          viewerAlreadySeated: tourActive,
          history: priorTurns,
        });
        if (!speech.speak) {
          narrateGuideRef.current = true;
          try {
            for (const action of actions) await executeAction(action);
          } finally {
            narrateGuideRef.current = false;
          }
          setPhase("idle");
          if (speech.advanceWithoutSpeech) queueGuidedAdvance();
          return;
        }
        deliverSpeech(speech.answer, actions, sources);
      } catch (e) {
        setSearching(false);
        if (e instanceof DOMException && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "Tutor error";
        setTurns((prev) => [...prev, { id: nextId(), role: "assistant", text: msg, error: true }]);
        toast({ title: "Tutor unavailable", description: msg, variant: "danger" });
        // Leave Continue available. A still-active tour hides that button
        // whenever we are not speaking, which soft-locks the walk-through.
        if (mode === "guided") {
          tourActiveRef.current = false;
          setTourActive(false);
        }
        setPhase("idle");
      }
    },
    [caseData.caseId, caseData.authorId, mode, orderedFindings, executeAction, toast, revealFinding, examMode, courseId]
  );

  runTutorRef.current = runTutor;

  const finishTour = useCallback(() => {
    tourActiveRef.current = false;
    setTourActive(false);
    if (courseId) {
      void fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          courseId,
          caseId: caseData.caseId,
          markComplete: true,
          lastOpenedCaseId: caseData.caseId,
        }),
      }).catch(() => undefined);
    }
    void runTutorRef.current(
      "Tour complete. Model a concise Impression for this case from the authored findings only, then invite the registrar to ask questions or practice dictating Findings.",
      turnsRef.current
    );
  }, [courseId, caseData.caseId]);

  finishTourRef.current = finishTour;

  const runGuidedFrom = useCallback(
    async (index: number) => {
      const gen = ++tourGenRef.current;
      const stale = () => gen !== tourGenRef.current || !tourActiveRef.current;
      if (!tourActiveRef.current) return;
      if (index >= orderedFindings.length) {
        finishTour();
        return;
      }
      const finding = orderedFindings[index];
      if (!finding) return;
      const guide = resolveTeachingGuide(finding);
      if (guide && guideHasMotion(guide) && controls.current) {
        setActiveIndex(index);
        markRevealed(finding.id);
        const says = authoredGuideLines(guide);
        // A guide with motion but no authored lines used to play silently.
        // Speak a look-cue with the drive, then the name once the guide lands.
        // Demo scripts (LIDC) always have a line per beat, so this fallback
        // does not replace them. speak() caps a clip that never ends.
        const fallbackSentences = says.length
          ? []
          : splitSentences(
              tutorSpeechPlan({
                answer: "",
                actions: [{ type: "show_finding", findingId: finding.id }],
                mode: "guided",
                question: "Teach the finding now on screen.",
                findings: spokenSources(orderedFindings),
                currentFindingId: finding.id,
                tourActive: true,
              }).answer
            );
        const fallbackCue = fallbackSentences[0] ?? "";
        const fallbackRest = fallbackSentences.slice(1).join(" ");
        const turnId = says.length || fallbackCue ? nextId() : null;
        if (turnId) {
          setTurns((prev) => [...prev, { id: turnId, role: "assistant", text: "" }]);
          setPhase("speaking");
          setSpeakingTurnId(turnId);
        }
        const guidePlay = playFindingGuide(finding, guide, {
          narrate: says.length && turnId
            ? async (text) => {
                if (stale()) return;
                setTurns((prev) =>
                  prev.map((t) =>
                    t.id === turnId
                      ? { ...t, text: t.text ? `${t.text} ${text}` : text }
                      : t
                  )
                );
                await speak(text, undefined, { persona: "attending" });
              }
            : undefined,
        });
        const cuePlay =
          fallbackCue && turnId
            ? (async () => {
                if (stale()) return;
                setTurns((prev) =>
                  prev.map((t) => (t.id === turnId ? { ...t, text: fallbackCue } : t))
                );
                await speak(fallbackCue, undefined, { persona: "attending" });
              })()
            : Promise.resolve();
        await Promise.all([guidePlay, cuePlay]);
        if (stale()) return;
        if (fallbackRest && turnId) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === turnId ? { ...t, text: `${fallbackCue} ${fallbackRest}` } : t
            )
          );
          await speak(fallbackRest, undefined, { persona: "attending" });
        }
        if (stale()) return;
        setSpeakingTurnId((cur) => (cur === turnId ? null : cur));
        setPhase((p) => (p === "speaking" ? "idle" : p));
        if (finding.marker) {
          setMarker(finding.marker);
          setMarkerVisible(true);
        }
        const saved = finding.measurements ?? [];
        const drawn = measurementsFromGuide(guide);
        const meas = saved.length ? saved : drawn;
        // Native tool strokes stay on the viewport when they landed. The
        // overlay / measurement layer covers a miss, without doubling a hit.
        if (meas.length && controls.current?.annotationApplied !== true) {
          overlay.current?.clear();
          setMeasurements(meas);
          setMeasurementsVisible(true);
        } else if (!drawn.length && saved.length) {
          setMeasurements(saved);
          setMeasurementsVisible(true);
        }
        window.setTimeout(() => {
          if (gen !== tourGenRef.current || !tourActiveRef.current) return;
          const next = nextGuidedIndex(index, orderedFindings.length);
          if (next == null) {
            finishTour();
            return;
          }
          void runGuidedRef.current(next);
        }, 700);
        return;
      }
      await revealFinding(index, { spoil: true });
      if (stale()) return;
      void runTutorRef.current(
        "Teach the finding now on screen. Apply authored windowing and point if useful. Explain how a registrar should observe it and how to put it in the report. Two to three short sentences. Do not call next_in_tour.",
        turnsRef.current
      );
    },
    [
      orderedFindings,
      playFindingGuide,
      markRevealed,
      revealFinding,
      finishTour,
      caseData.authorId,
    ]
  );

  runGuidedRef.current = runGuidedFrom;

  // A beat that never reports another caption (hung TTS the player did not
  // cut, or a tween that ignored cancel) must not leave Speaking latched.
  // New caption text resets the timer, so a guide that is still advancing
  // is left alone. The last finding unlocks Continue; earlier ones advance.
  useEffect(() => {
    if (mode !== "guided" || !tourActive || phase !== "speaking") return;
    const gen = tourGenRef.current;
    const index = activeIndexRef.current;
    const timer = window.setTimeout(() => {
      if (tourGenRef.current !== gen || !tourActiveRef.current) return;
      stopSpeaking();
      stopReplay();
      setSpeakingTurnId(null);
      setPhase((current) => (current === "speaking" ? "idle" : current));
      const next = nextGuidedIndex(index, orderedFindings.length);
      if (next == null) {
        tourGenRef.current += 1;
        tourActiveRef.current = false;
        setTourActive(false);
        return;
      }
      void runGuidedRef.current(next);
    }, NARRATION_HOLD_MAX_MS + 2_000);
    return () => window.clearTimeout(timer);
  }, [mode, tourActive, phase, turns, orderedFindings.length, stopReplay]);

  const resumeTour = useCallback(() => {
    if (mode !== "guided" || busy) return;
    tourActiveRef.current = true;
    setTourActive(true);
    const cur = activeIndexRef.current;
    if (cur < 0) {
      void runGuidedRef.current(0);
      return;
    }
    if (cur >= orderedFindings.length - 1) {
      const finding = orderedFindings[cur];
      const guide = finding ? resolveTeachingGuide(finding) : null;
      if (guide && guideHasMotion(guide)) {
        void runGuidedRef.current(cur);
        return;
      }
      void runTutor(
        "Resume teaching. Model the Impression and invite practice dictation.",
        turnsRef.current
      );
      return;
    }
    void runGuidedRef.current(cur);
  }, [mode, busy, orderedFindings, runTutor]);

  // --- Typed question: straight to CALL 2 ----------------------------------
  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      pauseTour();
      stopSpeaking();
      stopReplay();
      const history = turnsRef.current;
      setTurns((prev) => [...prev, { id: nextId(), role: "user", text: trimmed }]);
      runTutor(trimmed, history);
    },
    [busy, runTutor, stopReplay, pauseTour]
  );

  const sayDontKnow = useCallback(() => {
    const cur = activeIndexRef.current;
    const finding = cur >= 0 ? orderedFindings[cur] : null;
    if (finding) {
      setHelpedIds((prev) =>
        prev.includes(finding.id) ? prev : [...prev, finding.id]
      );
    }
    if (cur >= 0) void revealFinding(cur, { spoil: true });
    sendText("I don't know. Please show me this finding and teach it.");
  }, [revealFinding, sendText, orderedFindings]);

  // --- Voice question: CALL 1 (transcribe) then CALL 2 (tutor) -------------
  const onMicStart = useCallback(async () => {
    if (busy) return;
    pauseTour();
    stopSpeaking();
    stopReplay();
    try {
      await recorder.start();
      setPhase("recording");
    } catch {
      toast({ title: "Microphone blocked", description: "Allow mic access to ask by voice.", variant: "warning" });
    }
  }, [busy, recorder, toast, stopReplay, pauseTour]);

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
      if (index < 0 || index >= orderedFindings.length) return;
      stopSpeaking();
      stopReplay();
      if (mode === "guided") {
        tourActiveRef.current = true;
        setTourActive(true);
        void runGuidedRef.current(index);
        return;
      }
      revealFinding(index, { spoil: true });
    },
    [busy, ready, orderedFindings.length, revealFinding, stopReplay, mode]
  );
  const next = useCallback(() => goTo(Math.min(activeIndexRef.current + 1, orderedFindings.length - 1)), [goTo, orderedFindings.length]);
  const prev = useCallback(() => goTo(Math.max(activeIndexRef.current - 1, 0)), [goTo]);

  const skip = useCallback(() => {
    if (busy || !ready) return;
    const cur = activeIndexRef.current;
    const nextIdx = Math.min(cur + 1, orderedFindings.length - 1);
    if (nextIdx === cur && cur >= 0) return;
    if (mode === "guided") {
      goTo(nextIdx);
      return;
    }
    stopSpeaking();
    stopReplay();
    void revealFinding(nextIdx, { spoil: !examMode });
  }, [busy, ready, orderedFindings.length, examMode, revealFinding, stopReplay, mode, goTo]);

  const revealCurrent = useCallback(() => {
    if (busy || !ready) return;
    const cur = activeIndexRef.current;
    if (cur < 0) return;
    const finding = orderedFindings[cur];
    if (finding) {
      setHelpedIds((prev) =>
        prev.includes(finding.id) ? prev : [...prev, finding.id]
      );
    }
    stopSpeaking();
    stopReplay();
    void revealFinding(cur, { spoil: true });
  }, [busy, ready, revealFinding, stopReplay, orderedFindings]);

  const onLocateClick = useCallback(
    (x: number, y: number) => {
      if (busy) return;
      const cur = activeIndexRef.current;
      const finding = cur >= 0 ? orderedFindings[cur] : null;
      if (!finding || !examMode) return;
      if (revealedIds.includes(finding.id)) return;
      const hit = clickHitsFinding(finding.marker, x, y);
      if (hit) {
        locateMissesRef.current = 0;
        setLocateHint("");
        setLocatedIds((prev) =>
          prev.includes(finding.id) ? prev : [...prev, finding.id]
        );
        void revealFinding(cur, { spoil: true });
        sendText("I clicked the finding on the image.");
        return;
      }
      locateMissesRef.current += 1;
      setLocateHint(
        locateMissesRef.current >= 2
          ? "Still not it — say you don't know, or try one more click."
          : "Not quite — click the lesion, or hold the mic to describe it."
      );
    },
    [busy, examMode, orderedFindings, revealedIds, revealFinding, sendText]
  );

  const toggleCompare = useCallback(() => {
    setCompareOpen((o) => {
      const next = !o;
      if (!next) {
        setSecondaryReady(false);
        setSecondaryMarkerVisible(false);
        return next;
      }
      if (series.length > 1) {
        const curUid = controls.current?.activeSeriesUID;
        const other = series.findIndex((s) => s.seriesInstanceUID !== curUid);
        setSecondarySeriesIndex(other >= 0 ? other : 1);
      } else {
        setSecondarySeriesIndex(0);
      }
      return next;
    });
  }, [series]);

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
      speak(
        turn.text,
        () => {
          setSpeakingTurnId((cur) => (cur === turn.id ? null : cur));
          setPhase((p) => (p === "speaking" ? "idle" : p));
        },
        { authorId: caseData.authorId }
      );
    },
    [speakingTurnId, phase, stopReplay, caseData.authorId]
  );

  // Seat the first finding once the viewer is ready, then start the experience.
  // Teach (guided): autonomous attending tour. Viva: examiner stem.
  // Reporting: seat + invite to model Findings on the viewer.
  useEffect(() => {
    if (!ready || startedRef.current || orderedFindings.length === 0) return;
    startedRef.current = true;
    if (mode === "guided") {
      tourActiveRef.current = true;
      setTourActive(true);
      void runGuidedRef.current(0);
      return;
    }
    if (mode === "reporting") {
      tourActiveRef.current = false;
      setTourActive(false);
      void revealFinding(0, { spoil: true }).then(() => {
        void runTutor(
          "You are coaching a structured report. Briefly introduce Technique for this modality, then start Findings: drive to the first finding and model how to dictate it. Two to three short sentences.",
          []
        );
      });
      return;
    }
    if (examMode) {
      void revealFinding(0, { spoil: false }).then(() => {
        if (mode === "viva") void runTutor("Begin the session.", []);
      });
    } else {
      void revealFinding(0);
    }
  }, [ready, orderedFindings.length, examMode, mode, revealFinding, runTutor]);

  // Mode switches: reset tour flag so we don't leak auto-advance into viva.
  useEffect(() => {
    if (mode !== "guided") {
      tourActiveRef.current = false;
      setTourActive(false);
    }
  }, [mode]);

  // Leaving exam mode uncovers the active finding so guided/report aren't blank.
  useEffect(() => {
    if (examMode) return;
    const f = orderedFindings[activeIndexRef.current];
    if (f) {
      markRevealed(f.id);
      if (f.marker) setMarkerVisible(true);
      const meas = f.measurements ?? [];
      setMeasurements(meas);
      setMeasurementsVisible(meas.length > 0);
    }
  }, [examMode, orderedFindings, markRevealed]);

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
    measurements,
    measurementsVisible,
    tourActive,
    pauseTour,
    resumeTour,
    turns,
    phase,
    busy,
    micState,
    micSupported: recorder.supported,
    orderedFindings,
    examMode,
    revealedIds,
    onViewerReady,
    sendText,
    onMicStart,
    onMicStop,
    onStopSpeaking,
    next,
    prev,
    goTo,
    skip,
    revealCurrent,
    sayDontKnow,
    secondaryControls,
    secondaryOverlay,
    secondaryReady,
    onSecondaryReady,
    secondaryMarker,
    secondaryMarkerVisible,
    secondarySeriesIndex,
    setSecondarySeriesIndex,
    compareOpen,
    toggleCompare,
    locateHint,
    vivaScore: {
      located: locatedIds.length,
      helped: helpedIds.length,
      total: orderedFindings.length,
    },
    onLocateClick,
    locateMode:
      examMode &&
      activeIndex >= 0 &&
      !!orderedFindings[activeIndex] &&
      !revealedIds.includes(orderedFindings[activeIndex].id),
    // Agent-orb + premium chat surface state.
    orbState,
    micLevel,
    searching,
    speakingTurnId,
    aiAvailable,
    replayTurn,
  };
}
