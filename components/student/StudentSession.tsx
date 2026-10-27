"use client";

// Student teaching session — Teach-first reading room.
//
// Full-bleed DICOM. An AI attending drives the viewer while teaching a
// registrar how to report. Dock = voice + Teach/Exam intent. Rail is optional
// transcript / finding spine. Capture tracks arm the model; they are not a tape.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Eye,
  GraduationCap,
  HelpCircle,
  Keyboard,
  MessageCircle,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { Badge, Button, IconButton, Kbd, MicButton, Tabs } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { CaseData } from "@/lib/types";
import type { CaseSeries, ViewerSource } from "@/lib/viewerSource";
import { caseSeriesToSource } from "@/lib/viewerSource";
import { lastTeacherSlice } from "@/lib/viewerLoad";
import { useResolvedSeries } from "@/components/viewer/useResolvedSeries";
import type { PrefetchManifest } from "@/lib/prefetch";
import {
  examinerCaptionTurn,
  examinerVisibleTurns,
  findingStepLabel,
} from "@/lib/examLocate";
import { StudentViewer } from "./StudentViewer";
import { FindingCards } from "./FindingCards";
import { TutorChat } from "./TutorChat";
import { CheckInCard } from "./CheckInCard";
import { AgentOrb, type OrbState } from "./AgentOrb";
import { useStudentSession, type SessionMode } from "./useStudentSession";
import { TutorCaption } from "./TutorCaption";
import { HotkeysOverlay } from "./HotkeysOverlay";
import { warmPrefetch } from "./prefetch";
import { ImagingLayout } from "@/components/viewer/ImagingLayout";
import { NARROW_LAYOUT_MEDIA } from "@/lib/viewerLayout";
import { ReportCoach } from "./ReportCoach";

type PanelTab = "lesson" | "ask";
type Intent = "teach" | "exam";

const ORB_TAGLINE: Record<OrbState, string> = {
  idle: "Open the microphone to start",
  listening: "Listening…",
  thinking: "Thinking…",
  searching: "Searching sources…",
  speaking: "Speaking…",
};

function intentFromMode(mode: SessionMode): Intent {
  return mode === "viva" || mode === "socratic" ? "exam" : "teach";
}

export default function StudentSession({
  caseData,
  source,
  series,
  manifest,
  imagingResolved,
  tutorVoice,
  courseId,
  initialIntent = "teach",
}: {
  caseData: CaseData;
  source: ViewerSource;
  series: CaseSeries[];
  manifest: PrefetchManifest | null;
  imagingResolved: boolean;
  /** When the author enrolled an ElevenLabs clone — disclose synthetic tutor voice. */
  tutorVoice?: { authorName: string; cloned: boolean } | null;
  /** When opened from a course curriculum — mark complete at end of Teach tour. */
  courseId?: string | null;
  /** Test-as-student handoff. Examiner opens the viva; Teach me stays guided. */
  initialIntent?: "teach" | "exam";
}) {
  // Teach is the product: autonomous attending. Exam = viva.
  const [mode, setMode] = useState<SessionMode>(initialIntent === "exam" ? "viva" : "guided");
  const [panel, setPanel] = useState<PanelTab>("ask");
  // Closed until measured. Opening both this drawer and the series rail on a
  // phone covers the image completely.
  const [railOpen, setRailOpen] = useState(false);
  const tutorChosen = useRef(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const hinted = series;
  const resolved = useResolvedSeries(caseData.caseId, hinted);
  const rail = resolved.series;
  const imagingLive =
    resolved.imagingLive || (imagingResolved && hinted.some((item) => item.studyInstanceUID));
  const showViewer = rail.length > 0 && (hinted.length > 0 || resolved.settled);
  const liveSource = useMemo(
    () => (rail[0] ? caseSeriesToSource(rail[0]) : source),
    [rail, source]
  );
  const openSlice = useMemo(
    () => lastTeacherSlice(caseData.findings, rail[0]?.seriesInstanceUID) ?? null,
    [caseData.findings, rail]
  );
  const s = useStudentSession(caseData, mode, rail, { courseId });
  const intent = intentFromMode(mode);

  useLayoutEffect(() => {
    const mq = window.matchMedia(NARROW_LAYOUT_MEDIA);
    const apply = () => {
      if (!tutorChosen.current) {
        setRailOpen(!mq.matches);
        tutorChosen.current = true;
        return;
      }
      if (mq.matches) setRailOpen(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const openAsk = useCallback(() => {
    setRailOpen(true);
    setPanel("ask");
  }, []);

  const setIntent = useCallback((next: Intent) => {
    if (next === "exam") {
      setMode("viva");
      setPanel("ask");
      return;
    }
    setMode("guided");
    setPanel("ask");
  }, []);

  // When switching into Teach after mount, kick the autonomous tour.
  const prevIntent = useRef(intent);
  useEffect(() => {
    if (prevIntent.current !== "teach" && intent === "teach" && s.ready) {
      s.resumeTour();
    }
    prevIntent.current = intent;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on intent edge
  }, [intent, s.ready]);

  // The question lives in the rail. Open it when the attending asks, and
  // keep the viewer on the anchor — the choices are text, not a click target.
  useEffect(() => {
    if (!s.checkIn) return;
    setRailOpen(true);
    setPanel("ask");
  }, [s.checkIn]);

  const [activeSeriesIndex, setActiveSeriesIndex] = useState(0);
  const onSeriesChange = useCallback(
    (uid: string) => {
      const idx = rail.findIndex((x) => x.seriesInstanceUID === uid);
      if (idx >= 0) setActiveSeriesIndex(idx);
    },
    [rail]
  );

  const typingRef = useRef(false);
  const onTypingFocus = useCallback(() => {
    typingRef.current = true;
    s.onStopSpeaking();
  }, [s]);
  const onTypingBlur = useCallback(() => {
    typingRef.current = false;
  }, []);

  useEffect(() => {
    if (manifest?.hasImaging) warmPrefetch(manifest);
  }, [manifest]);

  const heldRef = useRef(false);
  const hotkeyRef = useRef({
    busy: s.busy,
    speaking: s.phase === "speaking",
    recording: s.micState === "recording",
    liveOpen: s.liveStatus !== "closed",
    micSupported: s.micSupported,
    start: s.onMicStart,
    stop: s.onMicStop,
    bargeIn: s.pauseTour,
    awaitingAnswer: Boolean(s.checkIn),
    next: s.skip,
    prev: s.prev,
    reveal: s.revealCurrent,
    compare: s.toggleCompare,
    examMode: s.examMode,
  });
  hotkeyRef.current = {
    busy: s.busy,
    speaking: s.phase === "speaking",
    recording: s.micState === "recording",
    liveOpen: s.liveStatus !== "closed",
    micSupported: s.micSupported,
    start: s.onMicStart,
    stop: s.onMicStop,
    bargeIn: () => {
      s.pauseTour();
      s.onStopSpeaking();
    },
    awaitingAnswer: Boolean(s.checkIn),
    next: s.skip,
    prev: s.prev,
    reveal: s.revealCurrent,
    compare: s.toggleCompare,
    examMode: s.examMode,
  };
  useEffect(() => {
    const isTextTarget = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (typingRef.current || isTextTarget(e.target)) return;
        if (e.code === "Space" && !e.repeat) {
        const keys = hotkeyRef.current;
        e.preventDefault();
        if (!keys.micSupported) return;
        // The session stays open until the mic control hangs up. Releasing
        // Space must not end it. A second press while the attending is
        // speaking takes the floor.
        if (keys.liveOpen) {
          if (keys.speaking) keys.bargeIn();
          return;
        }
        void keys.start();
        return;
      }
      if (e.key === "?" ) {
        e.preventDefault();
        setKeysOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") {
        setKeysOpen(false);
        setRailOpen(false);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        hotkeyRef.current.compare();
      } else if (k === "n") {
        e.preventDefault();
        if (!hotkeyRef.current.busy) hotkeyRef.current.next();
      } else if (k === "p") {
        e.preventDefault();
        if (!hotkeyRef.current.busy) hotkeyRef.current.prev();
      } else if (k === "r" && hotkeyRef.current.examMode) {
        e.preventDefault();
        if (!hotkeyRef.current.busy) hotkeyRef.current.reveal();
      } else if (k === "t") {
        e.preventDefault();
        setRailOpen((o) => !o);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") heldRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [s.micSupported]);

  const hasFindings = s.orderedFindings.length > 0;
  const activeFinding =
    s.activeIndex >= 0 ? s.orderedFindings[s.activeIndex] : null;
  const activeRevealed = activeFinding
    ? s.revealedIds.includes(activeFinding.id)
    : false;
  const transcriptFloor = intent === "exam" ? s.examCaptionFloor : 0;
  // The rail and the footer caption share one slice. A floor that only the
  // footer honored left the Teach line ("Follow the stack…") under Examiner.
  const visibleTurns = useMemo(
    () => examinerVisibleTurns(s.turns, transcriptFloor),
    [s.turns, transcriptFloor]
  );
  const lastAssistant = useMemo(
    () => examinerCaptionTurn(visibleTurns, 0),
    [visibleTurns]
  );
  const captionText =
    s.locateHint ||
    lastAssistant?.text ||
    (s.liveStatus === "connecting"
      ? "Connecting the attending…"
      : s.liveStatus === "closed" && s.ready
        ? "Scroll freely. Open the microphone to start."
        : "");
  const stepLabel = findingStepLabel(s.activeIndex, s.orderedFindings.length);

  const compareSeries =
    s.compareOpen && rail[s.secondarySeriesIndex]
      ? rail[s.secondarySeriesIndex]
      : null;
  // A fresh object every render reloads the compare stack at the mid-slice
  // default (33/65 soft-tissue on LIDC) and drops the secondary landing.
  const compareSourceKey = compareSeries
    ? `${compareSeries.wadoRsRoot}\0${compareSeries.studyInstanceUID}\0${compareSeries.seriesInstanceUID}`
    : "";
  const compareSource = useMemo(
    () => (compareSeries ? caseSeriesToSource(compareSeries) : null),
    // The key is the series identity. compareSeries is the object for that key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compareSourceKey]
  );

  const dockHint =
    intent === "exam" ? (
      s.locateMode ? (
        <>
          Click the image to locate · <Kbd>Space</Kbd> to talk
        </>
      ) : (
        <>
          Exam mode · <Kbd>Space</Kbd> to talk · Ask or answer
        </>
      )
    ) : s.checkIn ? (
      <>
        Check-in — answer in the tutor rail · <Kbd>Space</Kbd> interrupts
      </>
    ) : s.tourActive ? (
      <>
        Teaching — the viewer follows the tutor · <Kbd>Space</Kbd> interrupts
      </>
    ) : (
      <>Tour paused · Continue teaching or ask a question</>
    );

  return (
    <div className="flex h-dvh max-h-dvh w-full min-w-0 max-w-full flex-col overflow-hidden bg-canvas">
      <header className="z-30 flex shrink-0 flex-col border-b border-subtle bg-surface pt-[env(safe-area-inset-top)]">
        <div className="flex min-h-12 min-w-0 flex-wrap items-center justify-between gap-2 px-2 py-2 sm:px-3">
          <div className="flex min-w-0 items-center gap-2">
            <a
              href="/library"
              className="inline-flex h-11 shrink-0 items-center rounded-lg px-2.5 text-sm font-medium text-secondary hover:bg-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              Library
            </a>
            <h1 className="truncate font-display text-base font-semibold text-primary">
              {caseData.title}
            </h1>
            <Badge variant="neutral" className="hidden sm:inline-flex">
              {caseData.modality}
            </Badge>
            {stepLabel && (
              <Badge variant="accent" className="shrink-0 tabular-nums">
                Finding {stepLabel}
              </Badge>
            )}
            {intent === "exam" && s.vivaScore.total > 0 && (
              <Badge variant="neutral" className="hidden shrink-0 tabular-nums md:inline-flex">
                Located {s.vivaScore.located}/{s.vivaScore.total}
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <IconButton
              aria-label={s.compareOpen ? "Close compare" : "Open compare"}
              size="md"
              className="h-11 w-11"
              variant={s.compareOpen ? "primary" : "secondary"}
              onClick={s.toggleCompare}
            >
              <Columns2 className="h-4 w-4" />
            </IconButton>
            <IconButton
              aria-label="Keyboard shortcuts"
              size="md"
              className="h-11 w-11"
              variant="secondary"
              onClick={() => setKeysOpen(true)}
            >
              <Keyboard className="h-4 w-4" />
            </IconButton>
            <IconButton
              aria-label="Previous finding"
              size="md"
              className="h-11 w-11"
              variant="secondary"
              disabled={!hasFindings || s.activeIndex <= 0 || s.busy}
              onClick={s.prev}
            >
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <IconButton
              aria-label="Next finding"
              size="md"
              className="h-11 w-11"
              variant="secondary"
              disabled={
                !hasFindings ||
                s.activeIndex >= s.orderedFindings.length - 1 ||
                s.busy
              }
              onClick={s.skip}
            >
              <ChevronRight className="h-4 w-4" />
            </IconButton>
            <IconButton
              aria-label={railOpen ? "Collapse tutor rail" : "Open tutor rail"}
              size="md"
              className="h-11 w-11"
              variant="secondary"
              onClick={() => setRailOpen((o) => !o)}
            >
              {railOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </IconButton>
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "relative min-h-0 min-w-0 flex-1 bg-imaging",
            railOpen && "lg:mr-[380px]"
          )}
        >
          <ImagingLayout
            fill
            series={rail}
            seriesLoading={resolved.loading && rail.length === 0}
            listedSeries={manifest?.series}
            mainImageReady={s.ready}
            activeIndex={activeSeriesIndex}
            onSelectSeries={(index) => {
              const uid = rail[index]?.seriesInstanceUID;
              if (uid) onSeriesChange(uid);
            }}
            className="absolute inset-0"
            fullscreenDock={
              <MicButton
                state={s.micState}
                onStart={s.onMicStart}
                onStop={s.onMicStop}
                disabled={!s.micSupported || (s.busy && s.micState === "idle")}
                label={
                  s.liveStatus === "connecting"
                    ? "Connecting…"
                    : s.liveStatus === "open"
                      ? "End session"
                      : "Open microphone"
                }
              />
            }
          >
            {showViewer ? (
            <StudentViewer
          source={liveSource}
          series={rail}
          activeSeriesIndex={activeSeriesIndex}
          onSeriesChange={onSeriesChange}
          openSlice={openSlice}
          modality={caseData.modality}
          controls={s.controls}
          overlay={s.overlay}
          onReady={s.onViewerReady}
          marker={s.marker}
          markerVisible={
            s.markerVisible &&
            imagingLive &&
            (!s.examMode || activeRevealed)
          }
          measurements={s.measurements}
          measurementsVisible={
            s.measurementsVisible &&
            imagingLive &&
            (!s.examMode || activeRevealed)
          }
          replaying={s.replaying || s.pointing}
          ready={s.ready}
          locateMode={s.locateMode && imagingLive}
          onLocateClick={s.onLocateClick}
          secondary={
            s.compareOpen
              ? {
                  source: compareSource ?? liveSource,
                  series: rail.length > 0 ? rail : undefined,
                  activeSeriesIndex: s.secondarySeriesIndex,
                  onSeriesChange: (uid) => {
                    const idx = rail.findIndex((x) => x.seriesInstanceUID === uid);
                    if (idx >= 0) s.setSecondarySeriesIndex(idx);
                  },
                  controls: s.secondaryControls,
                  overlay: s.secondaryOverlay,
                  onReady: s.onSecondaryReady,
                  marker: s.secondaryMarker,
                  markerVisible:
                    s.secondaryMarkerVisible &&
                    imagingLive &&
                    (!s.examMode || activeRevealed),
                  ready: s.secondaryReady,
                  instanceId: "compare",
                  label: "Compare",
                }
              : null
          }
            />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <span className="rounded-md bg-black/80 px-3 py-1.5 text-xs text-white ring-1 ring-white/15">
                  Loading study…
                </span>
              </div>
            )}
          </ImagingLayout>
        </div>

      <aside
        className={cn(
          "absolute z-40 flex flex-col bg-surface/95 shadow-lg backdrop-blur transition-transform duration-300",
          "max-lg:inset-x-0 max-lg:bottom-0 max-lg:top-auto max-lg:h-[min(52dvh,24rem)] max-lg:w-full max-lg:border-t max-lg:border-subtle",
          "lg:inset-y-0 lg:right-0 lg:w-[380px] lg:border-l lg:border-subtle",
          railOpen
            ? "translate-x-0 translate-y-0"
            : "pointer-events-none max-lg:translate-y-full lg:translate-x-full"
        )}
        aria-hidden={!railOpen}
      >
        <div className="flex items-center gap-3 border-b border-subtle p-3">
          <AgentOrb state={s.orbState} level={s.micLevel} size="lg" className="shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-primary">
              {intent === "exam" ? "Examiner" : "Attending"}
            </h2>
            <p className="truncate text-xs text-muted">{ORB_TAGLINE[s.orbState]}</p>
          </div>
          <IconButton
            aria-label="Close tutor rail"
            size="sm"
            onClick={() => setRailOpen(false)}
          >
            <PanelRightClose className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="border-b border-subtle px-3 py-2">
          <Tabs
            variant="underline"
            items={[
              {
                value: "lesson",
                label: "Findings",
                icon: <GraduationCap className="h-4 w-4" aria-hidden="true" />,
                count: hasFindings ? s.orderedFindings.length : undefined,
              },
              {
                value: "ask",
                label: mode === "reporting" ? "Report" : "Discussion",
                icon: <MessageCircle className="h-4 w-4" aria-hidden="true" />,
              },
            ]}
            value={panel}
            onValueChange={(v) => setPanel(v as PanelTab)}
          />
        </div>

        <div className={cn("min-h-0 flex-1 flex-col", panel === "lesson" ? "flex" : "hidden")}>
          <FindingCards
            findings={s.orderedFindings}
            series={rail}
            caseModality={caseData.modality}
            activeIndex={s.activeIndex}
            replaying={s.replaying || s.pointing}
            busy={s.busy}
            ready={s.ready}
            onSelect={s.goTo}
            examMode={s.examMode}
            revealedIds={s.revealedIds}
          />
        </div>

        <div className={cn("min-h-0 flex-1 flex-col", panel === "ask" ? "flex" : "hidden")}>
          {mode === "reporting" && (
            <ReportCoach
              caseId={caseData.caseId}
              findings={s.orderedFindings}
              compact
              onAskTutor={s.sendText}
            />
          )}
          <TutorChat
            turns={visibleTurns}
            phase={s.phase}
            orbState={s.orbState}
            micState={s.micState}
            micSupported={s.micSupported}
            busy={s.busy}
            aiAvailable={s.aiAvailable}
            speakingTurnId={s.speakingTurnId}
            onSend={s.sendText}
            onMicStart={s.onMicStart}
            onMicStop={s.onMicStop}
            onStopSpeaking={s.onStopSpeaking}
            onReplayTurn={s.replayTurn}
            onTypingFocus={onTypingFocus}
            onTypingBlur={onTypingBlur}
            hideMic
            checkIn={s.checkIn}
            onAnswerCheckIn={s.answerCheckIn}
          />
        </div>
      </aside>
      </div>

      <footer className="z-30 shrink-0 border-t border-subtle bg-surface px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2.5">
          <TutorCaption
            text={captionText}
            revealed={!s.examMode || activeRevealed}
            modeLabel={
              intent === "exam"
                ? "Examiner"
                : mode === "reporting"
                  ? "Report coach"
                  : s.tourActive
                    ? "Teaching"
                    : "Attending"
            }
            sources={lastAssistant?.sources}
            className="self-stretch"
          />

          {hasFindings && (
            <div
              className="flex max-w-full items-center gap-0.5 overflow-x-auto"
              role="group"
              aria-label="Finding progress"
            >
              {s.orderedFindings.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  aria-label={`Finding ${i + 1}: ${f.label || "untitled"}`}
                  aria-current={i === s.activeIndex ? "true" : undefined}
                  disabled={s.busy}
                  onClick={() => s.goTo(i)}
                  className="flex h-8 min-w-8 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <span
                    className={cn(
                      "h-1.5 rounded-full",
                      i === s.activeIndex ? "w-5 bg-accent" : "w-1.5 bg-strong"
                    )}
                  />
                </button>
              ))}
            </div>
          )}

          {s.checkIn && !railOpen && (
            <CheckInCard
              prompt={s.checkIn.prompt}
              options={s.checkIn.options}
              onSelect={s.answerCheckIn}
            />
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            <div className="flex items-center rounded-lg border border-subtle bg-elevated p-1">
              <button
                type="button"
                aria-pressed={intent === "teach"}
                onClick={() => setIntent("teach")}
                className={cn(
                  "h-9 rounded-md px-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  intent === "teach"
                    ? "bg-accent text-accent-foreground"
                    : "text-secondary hover:text-primary"
                )}
              >
                Teach me the case
              </button>
              <button
                type="button"
                aria-pressed={intent === "exam"}
                onClick={() => setIntent("exam")}
                className={cn(
                  "h-9 rounded-md px-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  intent === "exam"
                    ? "bg-accent text-accent-foreground"
                    : "text-secondary hover:text-primary"
                )}
              >
                Examiner
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openAsk}
                aria-label="Open tutor transcript"
                className="flex h-11 items-center gap-2 rounded-lg px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <AgentOrb state={s.orbState} level={s.micLevel} size="sm" />
                <span className="hidden text-sm font-medium text-secondary sm:inline">
                  {ORB_TAGLINE[s.orbState]}
                </span>
              </button>
              <MicButton
                state={s.micState}
                onStart={s.onMicStart}
                onStop={s.onMicStop}
                disabled={!s.micSupported || (s.busy && s.micState === "idle")}
                label={
                  s.liveStatus === "connecting"
                    ? "Connecting…"
                    : s.liveStatus === "open"
                      ? "End session"
                      : "Open microphone"
                }
              />
              {s.examMode && hasFindings && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    leadingIcon={<HelpCircle className="h-3.5 w-3.5" />}
                    onClick={s.sayDontKnow}
                    disabled={s.busy}
                  >
                    Don&apos;t know
                  </Button>
                  {!activeRevealed && (
                    <Button
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Eye className="h-3.5 w-3.5" />}
                      onClick={s.revealCurrent}
                      disabled={s.busy}
                    >
                      Reveal
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>

          <p className="max-w-full text-center text-xs text-secondary">
            <span className="max-lg:hidden">{dockHint} · </span>
            Drag scrolls the stack · pinch zooms · <Kbd>?</Kbd>
          </p>
          {tutorVoice?.cloned && (
            <p className="text-center text-xs text-secondary">
              Tutor voice is a synthetic clone modeled on {tutorVoice.authorName}.
            </p>
          )}
        </div>
      </footer>


      <HotkeysOverlay open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}
