"use client";

// The student session state machine.
//
// Held microphone capture uses STT then a separate teaching plan. Commands
// are server-authorized and rendered sequentially before their speech.
// Scrolling never starts teaching; examination remains on its isolated path.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HoldToTalk, type HoldRelease } from "@/lib/tutor/holdToTalk";
import { TutorOrchestrator, type TutorBeat } from "@/lib/tutor/orchestrator";
import { plannerCommand, type TutorStep } from "@/lib/tutor/commands";
import { assertNoPhi } from "@/lib/phiGuard";
import { useRecorder, type Recording } from "@/components/useRecorder";
import { useToast, type MicState } from "@/components/ui";
import { speakBeats, stopSpeaking } from "@/lib/speak";
import {
  buildPerformancePlan,
  normalizeTutorActions,
} from "@/lib/performancePlan";
import {
  examHintLevel,
  seatExamReveal,
  spokenFindingSources,
  tutorSpeechPlan,
  type SpokenFindingSource,
} from "@/lib/tutorSpeech";
import { findingViewerState } from "@/lib/viewerController";
import { interruptGuidePlayback, type ReplayController } from "@/lib/replay";
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
import { useSketchLayer } from "./useSketchLayer";
import {
  resolveLiveTeachingPack,
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
  /** Approval IDs pinned when this answer was planned; replay cannot adopt later edits. */
  approvalIds?: string[];
  tutorBeats?: TutorBeat[];
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
  const sketch = useSketchLayer(controls);
  const overlay = useRef<ReplayOverlayHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const voiceAbortRef = useRef<AbortController | null>(null);
  const tutorRef = useRef<TutorOrchestrator | null>(null);
  const tutorTurnRef = useRef<string | null>(null);
  const tutorPlanRef = useRef<TutorBeat[]>([]);
  const tutorReplayRef = useRef(false);
  const holdRef = useRef<HoldToTalk<Recording> | null>(null);
  const [tutorNotice, setTutorNotice] = useState("");
  const [voiceReviewed, setVoiceReviewed] = useState(false);
  const voiceReviewedRef = useRef(voiceReviewed); voiceReviewedRef.current = voiceReviewed;
  const allowedApprovalRef = useRef<string[] | null>(null);
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
  const liveStatus = "closed" as "closed" | "connecting" | "open"; // Optional Live path is disabled.
  const liveStatusRef = useRef(liveStatus);
  liveStatusRef.current = liveStatus;
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
    tutorRef.current?.interrupt();
    abortRef.current?.abort(); voiceAbortRef.current?.abort();
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
      if (spoil) sketch.replay(teachingPackRef.current, finding.id);
      else sketch.clearAuthored();
      await seatSecondary(finding, spoil);
    },
    [orderedFindings, stopReplay, pointLaser, markRevealed, seatSecondary, commitFindingStep, sketch.replay, sketch.clearAuthored]
  );

  // --- Play a cleaned teach script (learner clock, not the mic tape) ------
  const ensureTutor = useCallback(() => {
    if (!tutorRef.current) tutorRef.current = new TutorOrchestrator({
      viewer: () => controls.current,
      stopSpeech: stopSpeaking,
      resolve: async (command, currentFindingId, currentView, signal) => {
        const res = await fetch(`/api/cases/${encodeURIComponent(caseData.caseId)}/tutor-commands`, { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ command, currentFindingId, currentView }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Approved tutor command unavailable.");
        const step = data as TutorStep;
        if (allowedApprovalRef.current && !allowedApprovalRef.current.includes(step.anchorId)) throw new Error("The approved evidence changed after planning. Ask again.");
        return step;
      },
      onStep: step => {
        const index = orderedFindingsRef.current.findIndex(f => f.id === step.findingId);
        if (index >= 0) { commitFindingStep(index); markRevealed(step.findingId); }
        setMarkerVisible(false); setMeasurementsVisible(false);
        window.dispatchEvent(new CustomEvent("radlearn:tutor", { detail: { type: "rendered", findingId: step.findingId, snapshot: controls.current?.getRenderedView?.()?.snapshot } }));
      },
      onState: (state, message) => {
        setTutorNotice(message ?? "");
        if (state === "speaking") setPhase("speaking");
        else if (state === "rendering" || state === "resolving") setPhase("thinking");
        else { setPhase("idle"); setSpeakingTurnId(null); }
        if (state === "failed") setTurns(prev => [...prev, { id: nextId(), role: "assistant", text: message ?? "Tutor stopped before speech.", error: true }]);
      },
      speak: async (text, signal) => {
        if (signal.aborted) return;
        const stop = () => stopSpeaking(); signal.addEventListener("abort", stop, { once: true });
        const id = tutorTurnRef.current;
        try { await speakBeats([text], { authorId: caseData.authorId, onStartBeat: () => {
          if (!signal.aborted && id) {
            setSpeakingTurnId(id);
            const replay = tutorReplayRef.current, beat = tutorPlanRef.current.shift();
            setTurns(prev => replay ? prev.map(t => t.id === id ? { ...t, liveCaption: text } : t) : commitSpokenProgress(prev, id, text, revealEpochRef.current, revealEpochRef.current).map(t => t.id === id && beat ? { ...t, tutorBeats: [...(t.tutorBeats ?? []), beat] } : t));
          }
        } }); } finally { signal.removeEventListener("abort", stop); }
      },
    });
    return tutorRef.current;
  }, [caseData.caseId, caseData.authorId, commitFindingStep, markRevealed]);

  // --- CALL 2: teaching plan (text question -> answer + action) ------------
  const runTutor = useCallback(
    async (question: string, history: ChatTurn[]) => {
      // A tutor call started under Teach must not speak or reveal after Exam.
      if (isExamMode(modeRef.current) && !isExamMode(mode)) return;
      const epoch = revealEpochRef.current, playbackGeneration = playbackGenRef.current;
      const staleTutor = () =>
        epoch !== revealEpochRef.current || playbackGeneration !== playbackGenRef.current ||
        (isExamMode(modeRef.current) && !isExamMode(mode));
      try { assertNoPhi({ question, history }); } catch { setTutorNotice("Remove patient identifiers before asking the tutor."); return; }
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
            if (ac.signal.aborted || staleTutor()) return;
            if (!tourActiveRef.current) return;
            if (atEnd) {
              finishTourRef.current();
              return;
            }
            void runGuidedRef.current(cur + 1);
          }, 1100);
        };

        const deliverSpeech = async (text: string, speechActions: ViewerAction[], sources: ChatSource[]) => {
          const beats = buildPerformancePlan(text, speechActions.map(plannerCommand));
          if (!beats.length) { setPhase("idle"); return; }
          const id = nextId(); tutorTurnRef.current = id;
          tutorReplayRef.current = false; tutorPlanRef.current = beats.filter(b => b.text.trim());
          setTurns(prev => appendGuideTurn(prev, { id, role: "assistant", text: "", sources, findingId: currentFindingId, approvalIds: [...(allowedApprovalRef.current ?? [])] }, epoch, revealEpochRef.current));
          const outcome = await ensureTutor().run(beats, currentFindingId);
          if (outcome === "completed" && !staleTutor()) queueGuidedAdvance();
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

        if (!res.ok) { if (res.status === 503) setAiAvailable(false); throw new Error(data.error || "Tutor unavailable"); }
        if (!Array.isArray(data.approvalIds) || data.approvalIds.some((id: unknown) => typeof id !== "string")) throw new Error("The tutor plan has no current approval references. Ask again.");
        allowedApprovalRef.current = data.approvalIds;
        setAiAvailable(true);

        const opening = question === "Begin the session.";
        // The server validates every command. Never silently drop a rejected
        // series action and speak over whichever image happened to remain.
        let actions = normalizeTutorActions(data as { action?: ViewerAction; actions?: ViewerAction[] });
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
        await deliverSpeech(speech.speak ? speech.answer : "", actions, sources);
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
    [caseData.caseId, caseData.authorId, mode, orderedFindings, ensureTutor, toast, revealFinding, examMode, courseId]
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

  const runGuidedFrom = useCallback(async (index: number) => {
    if (!tourActiveRef.current) return;
    if (index >= orderedFindings.length) { finishTour(); return; }
    interruptPlayback(); commitFindingStep(index);
    await runTutor("Teach the approved finding currently in focus.", turnsRef.current);
  }, [orderedFindings.length, finishTour, interruptPlayback, commitFindingStep, runTutor]);

  runGuidedRef.current = runGuidedFrom;

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

  // Held microphone capture uses two separate server calls; optional Live voice is not enabled here.
  const acceptRecording = useCallback(async (rec: Recording) => {
    if (isExamMode(modeRef.current) || !voiceReviewedRef.current) return;
    const epoch = playbackGenRef.current, ac = new AbortController(); voiceAbortRef.current = ac;
    const pendingId = nextId();
    const findingId = orderedFindingsRef.current[activeIndexRef.current]?.id;
    setTurns(prev => [...prev, { id: pendingId, role: "user", text: "", voice: true, pending: true, findingId }]); setPhase("transcribing");
    try {
      const res = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal, body: JSON.stringify({ audio: { base64: rec.base64, mime: rec.mimeType, phiReviewed: true } }) });
      const data = await res.json();
      if (ac.signal.aborted || epoch !== playbackGenRef.current) return;
      if (!res.ok) throw new Error(data.error || "Transcription failed");
      const transcript = String(data.transcript ?? "").trim(); assertNoPhi(transcript);
      if (!transcript) throw new Error("No speech detected. Hold and try again.");
      const history = turnsRef.current.filter(t => t.id !== pendingId);
      setTurns(prev => prev.map(t => t.id === pendingId ? { ...t, text: transcript, pending: false } : t));
      await runTutor(transcript, history);
    } catch (error) {
      if (!ac.signal.aborted && epoch === playbackGenRef.current) { setTutorNotice(error instanceof Error ? error.message : "Voice unavailable. Try again."); setPhase("idle"); }
    } finally { setTurns(prev => prev.filter(t => t.id !== pendingId || !t.pending)); }
  }, [runTutor]);
  const holdCallbacks = useRef({ recorder, pauseTour, acceptRecording }); holdCallbacks.current = { recorder, pauseTour, acceptRecording };
  if (!holdRef.current) holdRef.current = new HoldToTalk<Recording>({
    recorder: { start: () => holdCallbacks.current.recorder.start(), stop: () => holdCallbacks.current.recorder.stop() },
    interrupt: () => holdCallbacks.current.pauseTour(), submit: rec => holdCallbacks.current.acceptRecording(rec),
    state: (state, message) => { setPhase(state === "idle" ? "idle" : "recording"); setTutorNotice(message ?? (state === "starting" ? "Waiting for microphone permission…" : state === "recording" ? "Listening — release to send." : "")); },
  });
  const onMicStart = useCallback(() => {
    if (isExamMode(modeRef.current) || !controls.current) return;
    if (!voiceReviewedRef.current) { setTutorNotice("Confirm your question contains no patient identifiers before using the microphone."); return; }
    holdRef.current?.press();
  }, []);
  const onMicStop = useCallback(() => holdRef.current?.release(), []);
  const onMicCancel = useCallback((reason: HoldRelease = "cancel") => { holdRef.current?.release(reason); pauseTour(); }, [pauseTour]);

  // --- Tour controls (step rail) -------------------------------------------
  const goTo = useCallback(
    (index: number) => {
      if ((busy && liveStatusRef.current === "closed") || !ready) return;
      if (index < 0 || index >= orderedFindings.length) return;
      // Choosing a step seats the slice. It does not start a lecture.
      tourActiveRef.current = false;
      setTourActive(false);
      interruptPlayback();
      void revealFinding(index, { spoil: !isExamMode(modeRef.current) });
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

  const onStopSpeaking = useCallback(() => { interruptPlayback(); setSpeakingTurnId(null); setPhase("idle"); }, [interruptPlayback]);
  const replayTurn = useCallback((turn: ChatTurn) => {
    if (turn.role !== "assistant" || turn.error || !turn.text) return;
    if (speakingTurnId === turn.id) { onStopSpeaking(); return; }
    pauseTour(); tutorTurnRef.current = turn.id;
    if (!turn.approvalIds?.length || !turn.tutorBeats?.length) { setTutorNotice("This answer has no current approval reference. Ask the question again."); return; }
    allowedApprovalRef.current = turn.approvalIds;
    tutorReplayRef.current = true; tutorPlanRef.current = [];
    const findingId = turn.findingId ?? orderedFindingsRef.current[activeIndexRef.current]?.id;
    if (!findingId) { setTutorNotice("Choose an approved finding before replaying this answer."); return; }
    void ensureTutor().run(turn.tutorBeats, findingId);
  }, [speakingTurnId, onStopSpeaking, pauseTour, ensureTutor]);

  // Seat the first finding. Scrolling and opening the case do not start teaching.
  useEffect(() => {
    if (!ready || startedRef.current || orderedFindings.length === 0) return;
    startedRef.current = true;
    tourActiveRef.current = false;
    setTourActive(false);
    void revealFinding(0, { spoil: !isExamMode(modeRef.current) });
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
    if (examMode) {
      sketch.clearAuthored();
      return;
    }
    const f = orderedFindings[activeIndexRef.current];
    if (f) {
      sketch.replay(teachingPackRef.current, f.id);
      markRevealed(f.id);
      if (f.marker) setMarkerVisible(true);
      const meas = f.measurements ?? [];
      setMeasurements(meas);
      setMeasurementsVisible(meas.length > 0);
    }
  }, [examMode, orderedFindings, markRevealed, sketch.clearAuthored, sketch.replay]);

  // Cleanup: stop audio/replay + abort any in-flight tutor call on unmount.
  useEffect(
    () => () => {
      holdRef.current?.release("cancel"); voiceAbortRef.current?.abort(); tutorRef.current?.interrupt();
      checkInAbortRef.current?.abort();
      checkInResolveRef.current?.(-1);
      checkInResolveRef.current = null;
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
    onMicCancel, tutorNotice, voiceReviewed, setVoiceReviewed, manualOverride: onStopSpeaking,
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
    sketches: sketch.marks,
    noteImagePoint: sketch.noteImagePoint,
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
