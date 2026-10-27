"use client";

// The student session state machine.
//
// Opening the microphone starts a Gemini Live session loaded from the case's
// LiveTeachingPack. Scrolling the study does not start teaching. Hang up ends
// the session. Recorded-tour playback stays available as a tool the model may
// call; it does not autoplay. Examiner withholds the diagnosis. Teach me the
// case speaks and drives the viewer from authored anchors, including set_series.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecorder } from "@/components/useRecorder";
import { useToast, type MicState } from "@/components/ui";
import { primeAttendingSpeech, speakBeats, stopSpeaking } from "@/lib/speak";
import {
  buildPerformancePlan,
  normalizeTutorActions,
  splitSentences,
} from "@/lib/performancePlan";
import {
  NARRATION_HOLD_MAX_MS,
  examHintLevel,
  seatExamReveal,
  spokenFindingSources,
  tutorSpeechPlan,
  type SpokenFindingSource,
} from "@/lib/tutorSpeech";
import { findingViewerState } from "@/lib/viewerController";
import { interruptGuidePlayback, playTeachingGuide, type ReplayController } from "@/lib/replay";
import {
  adaptRemainingFromState,
  decisionBeatIndex,
  fallbackCheckIn,
  gradeCheckIn,
  loadTourCheckIn,
  recordCheckIn,
  type ActiveCheckIn,
  type CheckInBranch,
  type FindingCheckInState,
} from "@/lib/tourCheckIn";
import type { HarnessViewerAction } from "@/lib/harness/tools";
import { GeminiLiveSession, type LiveToolResult } from "@/lib/geminiLiveSession";
import { buildLiveContextUpdate, type LiveToolCall } from "@/lib/geminiLiveProtocol";
import {
  liveModeFromSession,
  livePackInstruction,
  livePackTools,
  liveSessionKick,
  resolveLiveTeachingPack,
  validateLiveToolCall,
} from "@/lib/liveTeachingPack";
import { authoredSeriesAllowlist, sanitizeSeriesActions } from "@/lib/setSeries";
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
import {
  appendGuideTurn,
  applyLocateClick,
  beginFindingStep,
  commitSelectedFinding,
  commitSpokenProgress,
  focusLiveCaption,
  examEntryTransition,
  isExamMode,
  locateModeArmed,
  mergeExamReveal,
  seatExamTranscript,
  settleFindingReveal,
} from "@/lib/examLocate";
import { nextGuidedIndex } from "@/lib/tourAdapt";
import {
  comparePaneSeriesIndex,
  secondaryAnchor,
  secondaryViewerState,
  wantsCompare,
} from "@/lib/findingAnchors";
import { compareSeatKey, planCompareSeat } from "@/lib/compareSeat";

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
  /** Finding this turn was about. The exam ladder climbs one finding at a time. */
  findingId?: string;
  /** A spoken (voice) user turn. */
  voice?: boolean;
  /** A user turn whose transcript hasn't arrived yet. */
  pending?: boolean;
  /** An assistant turn that is an error message. */
  error?: boolean;
  /** Web sources the tutor cited (assistant turns; from grounding). */
  sources?: ChatSource[];
  /**
   * Sentence whose audio just started. The rail keeps the full `text`.
   * The on-image caption prefers this so it moves with speech.
   */
  liveCaption?: string;
}

type ViewerAction = HarnessViewerAction;

function spokenSources(findings: Finding[], primaryDiagnosis?: string): SpokenFindingSource[] {
  return spokenFindingSources(findings, primaryDiagnosis);
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
  /**
   * Bumped by interruptPlayback. A guide narrate closure captures the value
   * from when its finding started and refuses to call speak() after a later
   * finding takes the floor.
   */
  const playbackGenRef = useRef(0);
  /**
   * Bumped when Teach hands off to Exam. A reveal or tutor call that started
   * on the old epoch must not uncover the marker after locate has armed.
   */
  const revealEpochRef = useRef(0);
  const modeRef = useRef(mode);
  /** play_guide is the only speech on this turn — speak its beats. */
  const narrateGuideRef = useRef(false);
  const runTutorRef = useRef<(q: string, h: ChatTurn[]) => Promise<void>>(
    async () => {}
  );
  const runGuidedRef = useRef<(index: number) => Promise<void>>(async () => {});
  const finishTourRef = useRef<() => void>(() => {});
  /** In-flight check-in fetch. Interrupt aborts it so a late payload cannot land. */
  const checkInAbortRef = useRef<AbortController | null>(null);
  /** Resolves the option the student picked, or -1 when the tour is paused. */
  const checkInResolveRef = useRef<((index: number) => void) | null>(null);
  /** Which assistant bubble the next guide line appends to. */
  const narrateTurnRef = useRef<string | null>(null);
  /** UIDs set_series may load. Rebuilt every render from the rail + anchors. */
  const seriesAllowRef = useRef<Set<string>>(new Set());
  const seriesAllow = authoredSeriesAllowlist({
    series,
    studyRefs: caseData.studyRefs,
    findings: caseData.findings,
    pack: caseData.liveTeachingPack,
  });
  const loadedSeries = new Set(series.map((item) => item.seriesInstanceUID));
  if (loadedSeries.size > 0) {
    for (const uid of seriesAllow) {
      if (!loadedSeries.has(uid)) seriesAllow.delete(uid);
    }
  }
  seriesAllowRef.current = seriesAllow;
  const seriesCatalogRef = useRef(series);
  seriesCatalogRef.current = series;
  const checkInsRef = useRef<FindingCheckInState[]>([]);

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
  /** Per-finding check-in results. Later beats in that finding read this. */
  const [checkIns, setCheckIns] = useState<FindingCheckInState[]>([]);
  /** MCQ on screen. Null while the tour is speaking a scripted beat. */
  const [checkIn, setCheckIn] = useState<ActiveCheckIn | null>(null);
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
  const compareOpenRef = useRef(false);
  compareOpenRef.current = compareOpen;
  /** Bumped when compare closes so an in-flight seat cannot reopen the pane. */
  const compareGenRef = useRef(0);
  const [locateHint, setLocateHint] = useState("");
  const locateMissesRef = useRef(0);
  const [locatedIds, setLocatedIds] = useState<string[]>([]);
  const [helpedIds, setHelpedIds] = useState<string[]>([]);
  /** Assistant turns before this index are Teach narration, not the exam caption. */
  const [examCaptionFloor, setExamCaptionFloor] = useState(0);
  const revealedIdsRef = useRef(revealedIds);
  revealedIdsRef.current = revealedIds;
  const locatedIdsRef = useRef(locatedIds);
  locatedIdsRef.current = locatedIds;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const liveRef = useRef<GeminiLiveSession | null>(null);
  const [liveStatus, setLiveStatus] = useState<"closed" | "connecting" | "open">("closed");
  const liveStatusRef = useRef(liveStatus);
  liveStatusRef.current = liveStatus;
  const liveUserTurn = useRef<string | null>(null);
  const liveAssistantTurn = useRef<string | null>(null);
  const kickRef = useRef("");
  const liveContextKey = useRef("");
  const liveModeRef = useRef(liveModeFromSession(mode));
  liveModeRef.current = liveModeFromSession(mode);
  // Mirror of `turns` so side-effecting handlers can read history without
  // running effects inside a setState updater (StrictMode-safe).
  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;

  const teachingPack = useMemo(() => resolveLiveTeachingPack(caseData), [caseData]);
  const teachingPackRef = useRef(teachingPack);
  teachingPackRef.current = teachingPack;
  const orderedFindings = useMemo(() => {
    const byId = new Map(caseData.findings.map((finding) => [finding.id, finding]));
    const ranked = teachingPack.findingOrder
      .map((id) => byId.get(id))
      .filter((finding): finding is Finding => Boolean(finding));
    const rest = caseData.findings
      .filter((finding) => !teachingPack.findingOrder.includes(finding.id))
      .sort((a, b) => a.order - b.order);
    return [...ranked, ...rest];
  }, [caseData, teachingPack]);
  const activeIndexRef = useRef(-1);
  activeIndexRef.current = activeIndex;
  const orderedFindingsRef = useRef(orderedFindings);
  orderedFindingsRef.current = orderedFindings;
  const findingCountRef = useRef(orderedFindings.length);
  findingCountRef.current = orderedFindings.length;
  /** Selection that owns the header badge. A late reveal must not rewind it. */
  const stepRef = useRef(beginFindingStep());

  const commitFindingStep = useCallback((index: number) => {
    const next = commitSelectedFinding(stepRef.current, index, findingCountRef.current);
    if (!next) return null;
    stepRef.current = next;
    activeIndexRef.current = next.activeIndex;
    setActiveIndex(next.activeIndex);
    return next;
  }, []);

  const busy = phase === "transcribing" || phase === "thinking";
  const startedRef = useRef(false);

  const markRevealed = useCallback((id: string, epoch = revealEpochRef.current) => {
    setRevealedIds((prev) => mergeExamReveal(prev, id, epoch, revealEpochRef.current));
  }, []);

  /**
   * Bumps on every compare-pane ready, including a remount that leaves
   * `secondaryReady` true. The boolean edge alone drops the secondary landing.
   */
  const secondaryViewportGenRef = useRef(0);
  const [secondaryViewportGen, setSecondaryViewportGen] = useState(0);
  /** `${viewportGeneration}:${findingId}` of the last successful apply. */
  const seatedCompareKeyRef = useRef("");

  const onSecondaryReady = useCallback((c: CornerstoneControls) => {
    secondaryControls.current = c;
    secondaryViewportGenRef.current += 1;
    setSecondaryViewportGen(secondaryViewportGenRef.current);
    setSecondaryReady(true);
  }, []);

  const seatSecondary = useCallback(
    async (finding: (typeof orderedFindings)[number], spoil: boolean) => {
      const gen = compareGenRef.current;
      const sec = secondaryAnchor(finding);
      const view = secondaryViewerState(finding);
      if (!sec || !view) {
        setSecondaryMarker(null);
        setSecondaryMarkerVisible(false);
        return;
      }
      if (gen !== compareGenRef.current) return;
      // Compare/C opens the pane. A finding change must not pop it open, and
      // must not move the primary viewport (close-compare restore stays intact).
      if (!compareOpenRef.current) {
        setSecondaryMarker(sec.marker ?? null);
        setSecondaryMarkerVisible(false);
        return;
      }
      const controlsReady = secondaryControls.current != null;
      const plan = planCompareSeat({
        compareOpen: true,
        openGeneration: gen,
        liveGeneration: compareGenRef.current,
        viewportGeneration: controlsReady ? secondaryViewportGenRef.current : 0,
        seatedKey: seatedCompareKeyRef.current,
        findingId: finding.id,
        view,
      });
      if (plan.action === "skip") return;
      setSecondarySeriesIndex(
        comparePaneSeriesIndex(series, finding, controls.current?.activeSeriesUID)
      );
      const c = secondaryControls.current;
      if (plan.action === "defer" || !c) {
        setSecondaryMarker(sec.marker ?? null);
        setSecondaryMarkerVisible(spoil);
        return;
      }
      const seatGen = secondaryViewportGenRef.current;
      try {
        if (
          sec.seriesInstanceUID &&
          c.seriesUIDs.includes(sec.seriesInstanceUID) &&
          c.activeSeriesUID !== sec.seriesInstanceUID
        ) {
          c.showSeries(sec.seriesInstanceUID);
          await c.settle();
        }
        if (gen !== compareGenRef.current) return;
        if (secondaryViewportGenRef.current !== seatGen) return;
        // Slice, window, and camera on the compare pane only. The primary
        // viewport is not touched, so closing compare can still restore the
        // teach lung window (#45/#46).
        await c.showState(plan.view, 500);
      } catch {
        return;
      }
      if (gen !== compareGenRef.current) return;
      if (secondaryViewportGenRef.current !== seatGen) return;
      const current = orderedFindingsRef.current[activeIndexRef.current];
      if (current && current.id !== finding.id) return;
      seatedCompareKeyRef.current = compareSeatKey(seatGen, finding.id);
      setSecondaryMarker(sec.marker ?? null);
      setSecondaryMarkerVisible(spoil);
    },
    [series]
  );

  // Compare/C, finding changes, and every compare-pane ready. A secondary
  // anchor drives the pane. A finding without one leaves the manual second
  // series (or the only series) alone. Ready already being true is not a
  // reason to skip — a remount puts the stack back on the mid-slice default.
  useEffect(() => {
    if (!compareOpen) return;
    const finding = activeIndex >= 0 ? orderedFindings[activeIndex] : null;
    if (!finding || !wantsCompare(finding)) return;
    const spoil = !examMode || revealedIdsRef.current.includes(finding.id);
    void seatSecondary(finding, spoil);
  }, [compareOpen, activeIndex, orderedFindings, examMode, seatSecondary, secondaryViewportGen]);

  useEffect(() => {
    if (!compareOpen || !examMode) return;
    const finding = activeIndex >= 0 ? orderedFindings[activeIndex] : null;
    if (!finding || !wantsCompare(finding)) return;
    setSecondaryMarkerVisible(revealedIds.includes(finding.id));
  }, [compareOpen, examMode, activeIndex, revealedIds, orderedFindings]);

  const micState: MicState =
    liveStatus === "connecting" || liveStatus === "open" || phase === "recording"
      ? "recording"
      : phase === "transcribing"
        ? "processing"
        : "idle";

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
    if (liveStatus !== "closed") return;
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
  }, [phase, liveStatus]);

  // --- Viewer ready ---------------------------------------------------------
  const onViewerReady = useCallback((c: CornerstoneControls) => {
    controls.current = c;
    setReady(true);
  }, []);

  // Stop any in-flight finding replay (track retrace). Does not stop TTS:
  // a tutor sentence may still be speaking while the viewer moves.
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

  const releaseCheckIn = useCallback((index: number) => {
    const resolve = checkInResolveRef.current;
    checkInResolveRef.current = null;
    setCheckIn(null);
    if (index < 0 && resolve) {
      setSpeakingTurnId(null);
      setPhase((phase) => (phase === "speaking" ? "idle" : phase));
    }
    resolve?.(index);
  }, []);

  const answerCheckIn = useCallback(
    (index: number) => {
      releaseCheckIn(index);
    },
    [releaseCheckIn]
  );

  // Finding change and tour advance. Cancel the guide first, then TTS.
  // speak() after stopSpeaking starts a new clip — that is how the previous
  // finding's "Follow the stack." was landing on the notes finding.
  const interruptPlayback = useCallback(() => {
    checkInAbortRef.current?.abort();
    releaseCheckIn(-1);
    playbackGenRef.current += 1;
    const ctrl = replayRef.current;
    replayRef.current = null;
    interruptGuidePlayback(ctrl, stopSpeaking);
    if (replayAudioRef.current) {
      replayAudioRef.current.pause();
      replayAudioRef.current = null;
    }
    overlay.current?.clear();
    controls.current?.clearAnnotations?.();
    setReplaying(false);
    setPointing(false);
  }, [releaseCheckIn]);

  const pauseTour = useCallback(() => {
    tourGenRef.current += 1;
    tourActiveRef.current = false;
    setTourActive(false);
    interruptPlayback();
  }, [interruptPlayback]);

  // Prefetch the next beat's first sentence. speakBeats plays that sentence
  // from the primed blob and fetches any further sentences while it plays.
  const primeGuideLine = useCallback((text: string) => {
    const first = splitSentences(text)[0];
    if (first) primeAttendingSpeech(first);
  }, []);

  const speakGuideSentences = useCallback(
    async (turnId: string, text: string, stale: () => boolean) => {
      const sentences = splitSentences(text);
      if (sentences.length === 0 || stale()) return;
      await speakBeats(sentences, {
        persona: "attending",
        onStartBeat: (index) => {
          if (stale()) return;
          const sentence = sentences[index] ?? "";
          const lineEpoch = revealEpochRef.current;
          setTurns((prev) =>
            commitSpokenProgress(prev, turnId, sentence, lineEpoch, revealEpochRef.current)
          );
        },
      });
    },
    []
  );

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
      const epoch = revealEpochRef.current;
      const finding = orderedFindings[index];
      if (!finding || !controls.current) return;
      // The badge, dots, and locate target follow the selection now. showState
      // snaps the slice and then tweens the camera; waiting for that promise
      // left "Finding 1 / 3" on screen after the stack had already moved.
      const committed = commitFindingStep(index);
      if (!committed) return;
      const selection = committed.selection;
      const stillCurrent = () => stepRef.current.selection === selection;
      const spoil = opts?.spoil !== false;
      stopReplay();
      setMarkerVisible(false);
      setMeasurementsVisible(false);
      setLocateHint("");
      locateMissesRef.current = 0;

      // Multi-series: if this finding is anchored to a specific series, switch
      // the viewport to it before we drive the view. showSeries reads the
      // loaded stack, not the rail DOM, so a collapsed list still switches.
      // onSeriesChange keeps the highlight ready for when the rail opens.
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
      if (!stillCurrent()) return;
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
      // A newer selection owns the step. Do not rewind the badge or paint
      // this finding's marker over it. Exam entry still blocks the spoiler
      // (#41) without giving the step back to the previous finding.
      const settled = settleFindingReveal(stepRef.current, {
        index,
        count: orderedFindings.length,
        selection,
      });
      if (settled.selection !== selection) return;
      stepRef.current = settled;
      activeIndexRef.current = settled.activeIndex;
      setActiveIndex(settled.activeIndex);
      if (epoch !== revealEpochRef.current) return;
      const m = finding.marker ?? null;
      const meas = finding.measurements ?? [];
      setMeasurements(meas);
      if (spoil && m && Number.isFinite(m.x_pct) && Number.isFinite(m.y_pct)) {
        markRevealed(finding.id, epoch);
        await pointLaser(m.x_pct, m.y_pct, m);
        if (!stillCurrent()) return;
        if (epoch !== revealEpochRef.current) {
          setMarkerVisible(false);
          setMeasurementsVisible(false);
          return;
        }
        setMeasurementsVisible(meas.length > 0);
      } else {
        setMarker(m);
        setMarkerVisible(false);
        setMeasurementsVisible(spoil && meas.length > 0);
      }
      if (!stillCurrent() || epoch !== revealEpochRef.current) return;
      await seatSecondary(finding, spoil);
    },
    [orderedFindings, stopReplay, pointLaser, markRevealed, seatSecondary, commitFindingStep]
  );

  // --- Play a cleaned teach script (learner clock, not the mic tape) ------
  const playFindingGuide = useCallback(
    async (
      finding: Finding,
      guide: TeachingGuide,
      opts?: {
        narrate?: (text: string) => Promise<void>;
        primeNarration?: (text: string) => void;
        onCheckIn?: (ctx: {
          beat: { say?: string };
          index: number;
        }) => Promise<CheckInBranch | "skip" | "paused" | null | void>;
      }
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
          primeNarration: opts?.primeNarration,
          onCheckIn: opts?.onCheckIn,
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
            (!seriesAllowRef.current.has(action.seriesInstanceUID) ||
              !controls.current?.seriesUIDs.includes(action.seriesInstanceUID))
          ) {
            break;
          }
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
        case "set_series": {
          // Collapsed rail is presentation. This uses the loaded series list.
          const uid = action.seriesInstanceUID;
          if (!uid || !seriesAllowRef.current.has(uid)) break;
          if (!controls.current?.seriesUIDs.includes(uid)) break;
          if (controls.current.activeSeriesUID !== uid) {
            controls.current.showSeries(uid);
            await controls.current.settle();
          }
          const view: {
            sliceIndex?: number;
            windowWidth?: number;
            windowCenter?: number;
          } = {};
          if (action.sliceIndex != null) view.sliceIndex = action.sliceIndex;
          if (action.ww != null && action.wc != null) {
            view.windowWidth = action.ww;
            view.windowCenter = action.wc;
          }
          if (view.sliceIndex != null || view.windowWidth != null) {
            await controls.current.showState(view, 520);
          }
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
          const epoch = revealEpochRef.current;
          const idx = orderedFindings.indexOf(target);
          // The guide owns the step from here. A later student selection
          // bumps the selection token, so this call cannot rewind the badge
          // when its viewer work finishes.
          if (idx >= 0) commitFindingStep(idx);
          markRevealed(target.id, epoch);
          const guide = resolveTeachingGuide(target);
          if (guide && guideHasMotion(guide)) {
            // A live answer is already in speakBeats. Speaking the guide on
            // top would cancel that clip. Narrate only when this call is the
            // speech (a tool-only turn with nothing else to say).
            if (narrateGuideRef.current) {
              interruptPlayback();
              const playbackGen = playbackGenRef.current;
              const turnId = nextId();
              setTurns((prev) =>
                appendGuideTurn(
                  prev,
                  { id: turnId, role: "assistant", text: "" },
                  epoch,
                  revealEpochRef.current
                )
              );
              setPhase("speaking");
              setSpeakingTurnId(turnId);
              await playFindingGuide(target, guide, {
                primeNarration: primeGuideLine,
                narrate: (text) =>
                  speakGuideSentences(
                    turnId,
                    text,
                    () => playbackGen !== playbackGenRef.current
                  ),
              });
              setSpeakingTurnId((cur) => (cur === turnId ? null : cur));
              setPhase((phase) => (phase === "speaking" ? "idle" : phase));
            } else {
              await playFindingGuide(target, guide);
            }
          } else if (idx >= 0) {
            await revealFinding(idx);
          }
          if (epoch !== revealEpochRef.current) break;
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
    [orderedFindings, revealFinding, pointLaser, playFindingGuide, markRevealed, interruptPlayback, commitFindingStep, primeGuideLine, speakGuideSentences]
  );

  // --- CALL 2: teaching plan (text question -> answer + action) ------------
  const runTutor = useCallback(
    async (question: string, history: ChatTurn[]) => {
      // A tutor call started under Teach must not speak or reveal after Exam.
      if (isExamMode(modeRef.current) && !isExamMode(mode)) return;
      const epoch = revealEpochRef.current;
      const staleTutor = () =>
        epoch !== revealEpochRef.current ||
        (isExamMode(modeRef.current) && !isExamMode(mode));
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
            messages: history.map((t) => ({
              role: t.role,
              text: t.text,
              findingId: t.findingId,
            })),
            currentFindingId:
              activeIndexRef.current >= 0
                ? orderedFindings[activeIndexRef.current]?.id
                : undefined,
            series: seriesCatalogRef.current.map((item) => ({
              seriesInstanceUID: item.seriesInstanceUID,
              modality: item.modality,
              description: item.description,
              seriesNumber: item.seriesNumber,
              instanceCount: item.instanceCount,
            })),
          }),
        });
        if (staleTutor()) return;
        const data = await res.json();
        if (staleTutor()) return;
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
          const epoch = revealEpochRef.current;
          setTurns((prev) =>
            appendGuideTurn(
              prev,
              { id, role: "assistant", text: "", sources, findingId: currentFindingId },
              epoch,
              revealEpochRef.current
            )
          );
          setPhase("speaking");
          setSpeakingTurnId(id);
          void speakBeats(
            spoken.map((beat) => beat.text),
            {
              authorId: caseData.authorId,
              onStartBeat: (i) => {
                const sentence = spoken[i]?.text ?? "";
                setTurns((prev) =>
                  commitSpokenProgress(prev, id, sentence, epoch, revealEpochRef.current)
                );
                // This sentence's tools start with the sentence, not after
                // the whole answer has been spoken.
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

        const priorTurns = history.map((turn) => ({
          role: turn.role,
          text: turn.text,
          findingId: turn.findingId,
        }));
        const spokenFindings = spokenSources(orderedFindings, caseData.primaryDiagnosis);
        const examLevel = examMode
          ? examHintLevel({
              mode,
              question,
              findings: spokenFindings,
              history: priorTurns,
              currentFindingId,
              finding: spokenFindings.find((item) => item.id === currentFindingId),
            })
          : 3;

        if (!res.ok) {
          // 503 means GEMINI_API_KEY isn't set — still speak an authored line
          // (Teach) or the exam stem (viva) instead of a silent error toast.
          // A partial exam answer climbs the hint ladder instead of the stem.
          if (res.status === 503) {
            setAiAvailable(false);
            setSearching(false);
            const offlineActions = examMode
              ? seatExamReveal([], examLevel, currentFindingId)
              : [];
            const speech = tutorSpeechPlan({
              answer: "",
              actions: offlineActions,
              mode,
              question,
              findings: spokenFindings,
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
              if (staleTutor()) return;
              deliverSpeech(line, offlineActions, []);
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
        let actions = sanitizeSeriesActions(
          normalizeTutorActions(
            data as { action?: ViewerAction; actions?: ViewerAction[] }
          ),
          seriesAllowRef.current
        );
        // Opening a viva: we already seated the slice. Don't spoil the
        // marker just because the model called show_finding with the stem.
        if (examMode && opening) {
          actions = actions.filter((a) => a.type !== "show_finding");
        }
        if (examMode) actions = seatExamReveal(actions, examLevel, currentFindingId);

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
          findings: spokenFindings,
          currentFindingId,
          tourActive,
          viewerAlreadySeated: tourActive,
          history: priorTurns,
        });
        if (staleTutor()) return;
        if (!speech.speak) {
          narrateGuideRef.current = true;
          try {
            for (const action of actions) {
              if (staleTutor()) return;
              await executeAction(action);
            }
          } finally {
            narrateGuideRef.current = false;
          }
          if (staleTutor()) return;
          setPhase("idle");
          if (speech.advanceWithoutSpeech) queueGuidedAdvance();
          return;
        }
        deliverSpeech(speech.answer, actions, sources);
      } catch (e) {
        if (staleTutor()) return;
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
      // Drop the previous finding's guide and any clip still in flight
      // before this finding is the one on screen. Tour auto-advance uses
      // this same entry, not only the finding rail.
      interruptPlayback();
      const playbackGen = playbackGenRef.current;
      const lineStale = () => stale() || playbackGen !== playbackGenRef.current;
      if (index >= orderedFindings.length) {
        finishTour();
        return;
      }
      const finding = orderedFindings[index];
      if (!finding) return;
      const guide = resolveTeachingGuide(finding);
      if (guide && guideHasMotion(guide) && controls.current) {
        commitFindingStep(index);
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
                findings: spokenSources(orderedFindings, caseData.primaryDiagnosis),
                currentFindingId: finding.id,
                tourActive: true,
              }).answer
            );
        const fallbackCue = fallbackSentences[0] ?? "";
        const fallbackRest = fallbackSentences.slice(1).join(" ");
        const ask = decisionBeatIndex(guide) != null;
        const turnId = says.length || fallbackCue || ask ? nextId() : null;
        const epoch = revealEpochRef.current;
        narrateTurnRef.current = turnId;
        if (turnId) {
          setTurns((prev) =>
            appendGuideTurn(
              prev,
              { id: turnId, role: "assistant", text: "" },
              epoch,
              revealEpochRef.current
            )
          );
          setPhase("speaking");
          setSpeakingTurnId(turnId);
        }
        const readyRef: { current: Awaited<ReturnType<typeof loadTourCheckIn>> | undefined } = {
          current: undefined,
        };
        if (ask) {
          const ac = new AbortController();
          checkInAbortRef.current = ac;
          void loadTourCheckIn(finding, ac.signal).then((value) => {
            if (ac.signal.aborted) return;
            readyRef.current = value;
          });
        }
        const guidePlay = playFindingGuide(finding, guide, {
          primeNarration: primeGuideLine,
          narrate: turnId
            ? (text) => {
                const id = narrateTurnRef.current ?? turnId;
                if (lineStale()) return Promise.resolve();
                setPhase("speaking");
                setSpeakingTurnId(id);
                return speakGuideSentences(id, text, lineStale);
              }
            : undefined,
          onCheckIn: ask
            ? async () => {
                if (stale()) return "paused";
                const check =
                  readyRef.current !== undefined ? readyRef.current : fallbackCheckIn(finding);
                if (!check || stale()) return "skip";
                const qId = nextId();
                setTurns((prev) =>
                  appendGuideTurn(
                    prev,
                    { id: qId, role: "assistant", text: "" },
                    epoch,
                    revealEpochRef.current
                  )
                );
                setPhase("speaking");
                setSpeakingTurnId(qId);
                const askGen = tourGenRef.current;
                const pickedPromise = new Promise<number>((resolve) => {
                  checkInResolveRef.current = resolve;
                  setCheckIn({
                    findingId: finding.id,
                    prompt: check.prompt,
                    options: check.options,
                  });
                });
                // The card is up before the clip ends so Space and the choices
                // both work while the question is still being spoken.
                void speakGuideSentences(qId, check.prompt, lineStale).finally(() => {
                  if (tourGenRef.current !== askGen) return;
                  if (!checkInResolveRef.current) return;
                  setSpeakingTurnId((id) => (id === qId ? null : id));
                  setPhase((phase) => (phase === "speaking" ? "idle" : phase));
                });
                const picked = await pickedPromise;
                if (picked < 0 || stale()) return "paused";
                const result = gradeCheckIn(check, picked);
                const nextState = recordCheckIn(checkInsRef.current, {
                  findingId: finding.id,
                  result,
                  prompt: check.prompt,
                });
                checkInsRef.current = nextState;
                setCheckIns(nextState);
                const option = check.options[picked] ?? "Don't know";
                const userId = nextId();
                const replyId = nextId();
                narrateTurnRef.current = replyId;
                setTurns((prev) =>
                  appendGuideTurn(
                    [
                      ...prev,
                      {
                        id: userId,
                        role: "user" as const,
                        text: option,
                        findingId: finding.id,
                      },
                    ],
                    { id: replyId, role: "assistant", text: "" },
                    epoch,
                    revealEpochRef.current
                  )
                );
                setPhase("speaking");
                setSpeakingTurnId(replyId);
                return adaptRemainingFromState(guide, nextState, finding.id, check) ?? "skip";
              }
            : undefined,
        });
        const cuePlay =
          fallbackCue && turnId
            ? speakGuideSentences(turnId, fallbackCue, lineStale)
            : Promise.resolve();
        await Promise.all([guidePlay, cuePlay]);
        if (stale() || playbackGen !== playbackGenRef.current) return;
        if (fallbackRest && turnId) {
          await speakGuideSentences(turnId, fallbackRest, lineStale);
        }
        if (stale() || playbackGen !== playbackGenRef.current) return;
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
      interruptPlayback,
      commitFindingStep,
      primeGuideLine,
      speakGuideSentences,
    ]
  );

  runGuidedRef.current = runGuidedFrom;

  // A beat that never reports another caption (hung TTS the player did not
  // cut, or a tween that ignored cancel) must not leave Speaking latched.
  // New caption text resets the timer, so a guide that is still advancing
  // is left alone. The last finding unlocks Continue; earlier ones advance.
  useEffect(() => {
    // A check-in is a deliberate pause. Hung-speech recovery must not skip it.
    if (mode !== "guided" || !tourActive || phase !== "speaking" || checkIn) return;
    const gen = tourGenRef.current;
    const index = activeIndexRef.current;
    const timer = window.setTimeout(() => {
      if (tourGenRef.current !== gen || !tourActiveRef.current) return;
      interruptPlayback();
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
  }, [mode, tourActive, phase, turns, orderedFindings.length, interruptPlayback, checkIn]);

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
      if (liveRef.current?.isOpen) {
        const findingId =
          activeIndexRef.current >= 0
            ? orderedFindingsRef.current[activeIndexRef.current]?.id
            : undefined;
        setTurns((prev) => [...prev, { id: nextId(), role: "user", text: trimmed, findingId }]);
        liveRef.current.sendText(trimmed);
        return;
      }
      pauseTour();
      const history = turnsRef.current;
      const findingId =
        activeIndexRef.current >= 0
          ? orderedFindings[activeIndexRef.current]?.id
          : undefined;
      setTurns((prev) => [...prev, { id: nextId(), role: "user", text: trimmed, findingId }]);
      runTutor(trimmed, history);
    },
    [busy, orderedFindings, runTutor, pauseTour]
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

  const appendLiveTranscript = useCallback((role: "user" | "assistant", chunk: string) => {
    const piece = chunk.trim();
    if (!piece) return;
    if (role === "user" && kickRef.current && (kickRef.current.startsWith(piece) || piece === kickRef.current)) {
      return;
    }
    const findingId =
      activeIndexRef.current >= 0 ? orderedFindingsRef.current[activeIndexRef.current]?.id : undefined;
    setTurns((prev) => {
      const currentId = role === "user" ? liveUserTurn.current : liveAssistantTurn.current;
      if (currentId) {
        return prev.map((turn) => {
          if (turn.id !== currentId) return turn;
          const text = turn.text && piece.startsWith(turn.text) ? piece : `${turn.text} ${piece}`.replace(/\s+/g, " ").trim();
          return {
            ...turn,
            text,
            pending: false,
            liveCaption: role === "assistant" ? piece : turn.liveCaption,
          };
        });
      }
      const id = nextId();
      if (role === "user") liveUserTurn.current = id;
      else liveAssistantTurn.current = id;
      return [
        ...prev,
        {
          id,
          role,
          text: piece,
          voice: role === "user",
          findingId,
          liveCaption: role === "assistant" ? piece : undefined,
        },
      ];
    });
  }, []);

  const runLiveCall = useCallback(
    async (call: LiveToolCall): Promise<LiveToolResult> => {
      const pack = teachingPackRef.current;
      const reply = (response: Record<string, unknown>): LiveToolResult => ({
        id: call.id,
        name: call.name,
        response,
      });
      const currentId =
        activeIndexRef.current >= 0 ? orderedFindingsRef.current[activeIndexRef.current]?.id : undefined;
      const decision = validateLiveToolCall(pack, call.name, call.args, currentId);
      if (!decision.ok) return reply({ ok: false, error: decision.error, allowedSeries: decision.allowedSeries });

      if (call.name === "web_search") {
        const query = decision.query ?? "";
        setSearching(true);
        try {
          const res = await fetch("/api/voice/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
          });
          const data = (await res.json()) as { answer?: string; error?: string; sources?: ChatSource[] };
          if (!res.ok) return reply({ ok: false, error: data.error || "Search failed" });
          if (data.sources?.length) {
            setTurns((prev) => {
              const id = liveAssistantTurn.current;
              if (!id) return prev;
              return prev.map((turn) => (turn.id === id ? { ...turn, sources: data.sources } : turn));
            });
          }
          return reply({ ok: true, answer: data.answer ?? "", sources: data.sources ?? [] });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Search failed";
          return reply({ ok: false, error: message });
        } finally {
          setSearching(false);
        }
      }

      const viewer = controls.current;
      if (!viewer) return reply({ ok: false, error: "Viewer is not ready.", drive: decision.drive });
      const spoil = liveModeRef.current === "teach_me";

      if (decision.findingId && (call.name === "show_finding" || call.name === "next_finding")) {
        const idx = orderedFindingsRef.current.findIndex((item) => item.id === decision.findingId);
        if (idx < 0) return reply({ ok: false, error: "That finding is not on this case." });
        await revealFinding(idx, { spoil });
        return reply({ ok: true, findingId: decision.findingId, drive: decision.drive });
      }

      if (decision.seriesInstanceUID) {
        // The series rail may be collapsed. That preference is not a gate.
        if (!viewer.seriesUIDs.includes(decision.seriesInstanceUID)) {
          return reply({
            ok: false,
            error: "That series is not loaded in the viewer.",
            allowedSeries: pack.authoredSeriesInstanceUIDs,
            drive: decision.drive,
          });
        }
        if (viewer.activeSeriesUID !== decision.seriesInstanceUID) {
          viewer.showSeries(decision.seriesInstanceUID);
          await viewer.settle();
        }
      }

      const view: { sliceIndex?: number; windowWidth?: number; windowCenter?: number; zoom?: number; pan?: [number, number] } = {};
      if (decision.sliceIndex != null) view.sliceIndex = decision.sliceIndex;
      if (decision.ww != null && decision.wc != null) {
        view.windowWidth = decision.ww;
        view.windowCenter = decision.wc;
      }
      if (decision.zoom != null) {
        view.zoom = decision.zoom;
        if (decision.panX != null && decision.panY != null) view.pan = [decision.panX, decision.panY];
      }
      if (Object.keys(view).length) await viewer.showState(view, 520);

      if (decision.x_pct != null && decision.y_pct != null) {
        const marker = { x_pct: decision.x_pct, y_pct: decision.y_pct, shape: "circle" as const };
        await pointLaser(decision.x_pct, decision.y_pct, spoil ? marker : undefined);
      }

      if (call.name === "draw_annotation" && decision.findingId) {
        const target = orderedFindingsRef.current.find((item) => item.id === decision.findingId);
        if (target) {
          const meas = target.measurements ?? [];
          setMeasurements(meas);
          setMeasurementsVisible(meas.length > 0);
          const guide = resolveTeachingGuide(target);
          const strokes = guide?.beats.flatMap((beat) => beat.actions.filter((action) => action.type === "annotate")) ?? [];
          for (const stroke of strokes) {
            const { type: _type, ...rest } = stroke;
            viewer.applyEvent({ t: 0, type: "annotation", ...rest });
          }
        }
      }

      return reply({
        ok: true,
        findingId: decision.findingId,
        seriesInstanceUID: decision.seriesInstanceUID,
        sliceIndex: decision.sliceIndex,
        ww: decision.ww,
        wc: decision.wc,
        drive: decision.drive,
      });
    },
    [pointLaser, revealFinding]
  );

  // --- Microphone opens Gemini Live. Hang up ends it. -----------------------
  const onMicStart = useCallback(async () => {
    if (liveRef.current || liveStatusRef.current !== "closed") return;
    pauseTour();
    tourActiveRef.current = false;
    setTourActive(false);
    const liveMode = liveModeRef.current;
    kickRef.current = liveSessionKick(liveMode);
    const session = new GeminiLiveSession({
      onPhase: (next) => {
        if (next === "connecting") {
          setLiveStatus("connecting");
          setPhase("recording");
          return;
        }
        setLiveStatus("open");
        setPhase(next === "speaking" ? "speaking" : "recording");
      },
      onInputTranscript: (text) => appendLiveTranscript("user", text),
      onOutputTranscript: (text) => appendLiveTranscript("assistant", text),
      onTurnComplete: () => {
        liveUserTurn.current = null;
        liveAssistantTurn.current = null;
      },
      onInterrupted: () => {
        setPhase("recording");
      },
      onSources: (sources) => {
        setTurns((prev) => {
          const id = liveAssistantTurn.current;
          if (!id) return prev;
          return prev.map((turn) => (turn.id === id ? { ...turn, sources } : turn));
        });
      },
      onToolCalls: async (calls) => {
        const results: LiveToolResult[] = [];
        for (const call of calls) results.push(await runLiveCall(call));
        return results;
      },
      onLevel: (level) => setMicLevel(level),
      onError: (message) => {
        toast({ title: "Live session", description: message, variant: "danger" });
      },
      onClose: () => {
        liveRef.current = null;
        liveUserTurn.current = null;
        liveAssistantTurn.current = null;
        setLiveStatus("closed");
        setPhase("idle");
        setMicLevel(0);
      },
    });
    liveRef.current = session;
    setLiveStatus("connecting");
    setPhase("recording");
    const pack = teachingPackRef.current;
    const focusId =
      activeIndexRef.current >= 0 ? orderedFindingsRef.current[activeIndexRef.current]?.id : pack.findingOrder[0];
    liveContextKey.current = `${liveMode}:${focusId ?? ""}`;
    await session.start({
      systemInstruction: livePackInstruction(pack, liveMode, caseData.title, focusId),
      tools: livePackTools(pack.authoredSeriesInstanceUIDs),
      openingText: kickRef.current,
    });
  }, [appendLiveTranscript, caseData.title, pauseTour, runLiveCall, toast]);

  // Finding or mode change replaces the speakable instruction and the full tool list.
  useEffect(() => {
    const session = liveRef.current;
    if (!session?.isOpen || liveStatus !== "open") return;
    const focusId = activeIndex >= 0 ? orderedFindings[activeIndex]?.id : undefined;
    const key = `${liveModeRef.current}:${focusId ?? ""}`;
    if (liveContextKey.current === key) return;
    liveContextKey.current = key;
    const pack = teachingPackRef.current;
    session.sendContextUpdate(
      buildLiveContextUpdate({
        systemInstruction: livePackInstruction(pack, liveModeRef.current, caseData.title, focusId),
        tools: livePackTools(pack.authoredSeriesInstanceUIDs),
      })
    );
  }, [liveStatus, activeIndex, mode, orderedFindings, caseData.title]);

  const onMicStop = useCallback(async () => {
    if (liveRef.current || liveStatusRef.current !== "closed") {
      liveRef.current?.hangup();
      return;
    }
    const rec = await recorder.stop();
    if (!rec) {
      setPhase("idle");
      return;
    }

    // Render a pending user turn immediately, fill it with the transcript.
    const pendingId = nextId();
    const findingId =
      activeIndexRef.current >= 0
        ? orderedFindings[activeIndexRef.current]?.id
        : undefined;
    setTurns((prev) => [
      ...prev,
      { id: pendingId, role: "user", text: "", voice: true, pending: true, findingId },
    ]);
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
  }, [orderedFindings, recorder, runTutor, toast]);

  // --- Tour controls (step rail) -------------------------------------------
  const goTo = useCallback(
    (index: number) => {
      if ((busy && liveStatusRef.current === "closed") || !ready) return;
      if (index < 0 || index >= orderedFindings.length) return;
      // Choosing a step seats the slice. It does not start a lecture.
      tourActiveRef.current = false;
      setTourActive(false);
      interruptPlayback();
      void revealFinding(index, { spoil: false });
    },
    [busy, ready, orderedFindings.length, revealFinding, interruptPlayback]
  );
  const next = useCallback(() => goTo(Math.min(activeIndexRef.current + 1, orderedFindings.length - 1)), [goTo, orderedFindings.length]);
  const prev = useCallback(() => goTo(Math.max(activeIndexRef.current - 1, 0)), [goTo]);

  const skip = useCallback(() => {
    if (busy || !ready) return;
    const cur = activeIndexRef.current;
    const nextIdx = Math.min(cur + 1, orderedFindings.length - 1);
    if (nextIdx === cur && cur >= 0) return;
    goTo(nextIdx);
  }, [busy, ready, orderedFindings.length, goTo]);

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
    interruptPlayback();
    void revealFinding(cur, { spoil: true });
  }, [busy, ready, revealFinding, interruptPlayback, orderedFindings]);

  const onLocateClick = useCallback(
    (x: number, y: number) => {
      const cur = activeIndexRef.current;
      const finding = cur >= 0 ? orderedFindings[cur] : null;
      const armed = locateModeArmed({
        examMode,
        finding,
        revealedIds: revealedIdsRef.current,
        locatedIds: locatedIdsRef.current,
      });
      const result = applyLocateClick({
        armed,
        busy: phaseRef.current === "transcribing" || phaseRef.current === "thinking",
        marker: finding?.marker,
        x,
        y,
        priorMisses: locateMissesRef.current,
      });
      if (result.type === "ignore" || !finding) return;
      if (result.type === "hit") {
        locateMissesRef.current = 0;
        setLocateHint("");
        setLocatedIds((prev) =>
          prev.includes(finding.id) ? prev : [...prev, finding.id]
        );
        void revealFinding(cur, { spoil: true });
        sendText("I clicked the finding on the image.");
        return;
      }
      locateMissesRef.current = result.misses;
      setLocateHint(result.hint);
    },
    [examMode, orderedFindings, revealFinding, sendText]
  );

  const toggleCompare = useCallback(() => {
    if (compareOpenRef.current) {
      compareGenRef.current += 1;
      seatedCompareKeyRef.current = "";
      setSecondaryReady(false);
      setSecondaryMarkerVisible(false);
      setCompareOpen(false);
      return;
    }
    const finding =
      activeIndexRef.current >= 0 ? orderedFindings[activeIndexRef.current] : null;
    setSecondarySeriesIndex(
      comparePaneSeriesIndex(series, finding, controls.current?.activeSeriesUID)
    );
    setCompareOpen(true);
  }, [orderedFindings, series]);

  const onStopSpeaking = useCallback(() => {
    if (liveRef.current) {
      liveRef.current.interruptPlayback();
      return;
    }
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
      interruptPlayback();
      setPhase("speaking");
      setSpeakingTurnId(turn.id);
      const sentences = splitSentences(turn.text);
      void speakBeats(sentences.length ? sentences : [turn.text], {
        authorId: caseData.authorId,
        onStartBeat: (index) => {
          const sentence = sentences[index] ?? turn.text;
          setTurns((prev) => focusLiveCaption(prev, turn.id, sentence));
        },
        onEnd: () => {
          setSpeakingTurnId((cur) => (cur === turn.id ? null : cur));
          setPhase((p) => (p === "speaking" ? "idle" : p));
        },
      });
    },
    [speakingTurnId, phase, interruptPlayback, caseData.authorId]
  );

  // Seat the first finding. Scrolling and opening the case do not start teaching.
  useEffect(() => {
    if (!ready || startedRef.current || orderedFindings.length === 0) return;
    startedRef.current = true;
    tourActiveRef.current = false;
    setTourActive(false);
    void revealFinding(0, { spoil: false });
  }, [ready, orderedFindings.length, revealFinding]);

  // Teach → Exam: the guide has already marked this finding revealed and is
  // often still speaking. Drop that spoiler, stop the clip, and let locate arm
  // on the authored marker. A finding the student already clicked stays open.
  useEffect(() => {
    const previous = modeRef.current;
    modeRef.current = mode;
    if (previous === mode) {
      if (mode !== "guided") {
        tourActiveRef.current = false;
        setTourActive(false);
      }
      return;
    }
    const entered = examEntryTransition({
      fromMode: previous,
      toMode: mode,
      phase: phaseRef.current,
      revealedIds: revealedIdsRef.current,
      locatedIds: locatedIdsRef.current,
    });
    if (!entered) {
      if (mode !== "guided") {
        tourActiveRef.current = false;
        setTourActive(false);
      }
      return;
    }
    revealEpochRef.current += 1;
    tourGenRef.current += 1;
    tourActiveRef.current = false;
    setTourActive(false);
    interruptPlayback();
    abortRef.current?.abort();
    setSpeakingTurnId(null);
    setPhase(entered.phase);
    setRevealedIds(entered.revealedIds);
    setMarkerVisible(false);
    setMeasurementsVisible(false);
    setSecondaryMarkerVisible(false);
    setLocateHint("");
    locateMissesRef.current = 0;
    // The floor used to hide this line from the footer only. The examiner
    // panel still rendered it. Replace the transcript with the exam stem
    // (or nothing, if the stem is blank) so both surfaces agree.
    const activeId =
      activeIndexRef.current >= 0
        ? orderedFindings[activeIndexRef.current]?.id
        : undefined;
    const seated = seatExamTranscript(turnsRef.current, {
      id: nextId(),
      role: "assistant" as const,
      text: examFallbackStem(orderedFindings.length),
      ...(activeId ? { findingId: activeId } : {}),
    });
    setTurns(seated.turns);
    setExamCaptionFloor(seated.captionFloor);
  }, [mode, interruptPlayback, orderedFindings]);

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
      checkInAbortRef.current?.abort();
      checkInResolveRef.current?.(-1);
      checkInResolveRef.current = null;
      liveRef.current?.hangup();
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
    checkIn,
    checkIns,
    answerCheckIn,
    turns,
    phase,
    busy,
    micState,
    liveStatus,
    micSupported: recorder.supported,
    orderedFindings,
    examMode,
    revealedIds,
    examCaptionFloor,
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
    locateMode: locateModeArmed({
      examMode,
      finding: activeIndex >= 0 ? orderedFindings[activeIndex] : null,
      revealedIds,
      locatedIds,
    }),
    // Agent-orb + premium chat surface state.
    orbState,
    micLevel,
    searching,
    speakingTurnId,
    aiAvailable,
    replayTurn,
  };
}
