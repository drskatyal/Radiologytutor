"use client";

// Student teaching session — Teach-first reading room.
//
// Full-bleed DICOM. An AI attending drives the viewer while teaching a
// registrar how to report. Dock = voice + Teach/Exam intent. Rail is optional
// transcript / finding spine. Capture tracks arm the model; they are not a tape.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Pause,
  Play,
} from "lucide-react";
import { Badge, Button, IconButton, Kbd, MicButton, Tabs } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { CaseData } from "@/lib/types";
import type { CaseSeries, ViewerSource } from "@/lib/viewerSource";
import { caseSeriesToSource } from "@/lib/viewerSource";
import type { PrefetchManifest } from "@/lib/prefetch";
import { StudentViewer } from "./StudentViewer";
import { FindingCards } from "./FindingCards";
import { TutorChat } from "./TutorChat";
import { AgentOrb, type OrbState } from "./AgentOrb";
import { useStudentSession, type SessionMode } from "./useStudentSession";
import { TutorCaption } from "./TutorCaption";
import { HotkeysOverlay } from "./HotkeysOverlay";
import { warmPrefetch } from "./prefetch";
import { SeriesNavigator } from "@/components/viewer/SeriesNavigator";
import { ReportCoach } from "./ReportCoach";

type PanelTab = "lesson" | "ask";
type Intent = "teach" | "exam";

const ORB_TAGLINE: Record<OrbState, string> = {
  idle: "Ready — hold mic or Space",
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
}) {
  // Teach is the product: autonomous attending. Exam = viva.
  const [mode, setMode] = useState<SessionMode>("guided");
  const [panel, setPanel] = useState<PanelTab>("ask");
  const [railOpen, setRailOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const s = useStudentSession(caseData, mode, series, { courseId });
  const intent = intentFromMode(mode);

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

  const [activeSeriesIndex, setActiveSeriesIndex] = useState(0);
  const onSeriesChange = useCallback(
    (uid: string) => {
      const idx = series.findIndex((x) => x.seriesInstanceUID === uid);
      if (idx >= 0) setActiveSeriesIndex(idx);
    },
    [series]
  );
  const showNavigator = series.length > 1;

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
    recording: s.micState === "recording",
    start: s.onMicStart,
    stop: s.onMicStop,
    next: s.skip,
    prev: s.prev,
    reveal: s.revealCurrent,
    compare: s.toggleCompare,
    examMode: s.examMode,
  });
  hotkeyRef.current = {
    busy: s.busy,
    recording: s.micState === "recording",
    start: s.onMicStart,
    stop: s.onMicStop,
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
      if (e.code === "Space" && !e.repeat && s.micSupported) {
        e.preventDefault();
        if (!heldRef.current && !hotkeyRef.current.busy) {
          heldRef.current = true;
          void hotkeyRef.current.start();
        }
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
      if (e.code === "Space" && heldRef.current) {
        heldRef.current = false;
        void hotkeyRef.current.stop();
      }
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
  const lastAssistant = useMemo(() => {
    for (let i = s.turns.length - 1; i >= 0; i--) {
      if (s.turns[i].role === "assistant" && !s.turns[i].error) return s.turns[i];
    }
    return null;
  }, [s.turns]);
  const waitingForTeach =
    intent === "teach" &&
    s.ready &&
    !s.locateHint &&
    !lastAssistant?.text &&
    (s.phase === "thinking" || s.phase === "idle");
  const captionText =
    s.locateHint ||
    lastAssistant?.text ||
    (waitingForTeach ? "Attending is seating the first finding…" : "");
  const stepLabel =
    hasFindings && s.activeIndex >= 0
      ? `${s.activeIndex + 1} / ${s.orderedFindings.length}`
      : undefined;

  const compareSeries =
    s.compareOpen && series[s.secondarySeriesIndex]
      ? series[s.secondarySeriesIndex]
      : null;

  const dockHint =
    intent === "exam"
      ? s.locateMode
        ? "Click the image to locate · Space to talk"
        : "Exam mode · Space to talk · Ask or answer"
      : s.tourActive
        ? "Teaching — viewer follows the tutor · Space to interrupt"
        : "Tour paused · Continue teaching or ask a question";

  return (
    <div className="relative h-screen bg-imaging">
      <div
        className={cn(
          "absolute inset-0 transition-[right] duration-300",
          railOpen ? "md:right-[380px]" : "right-0",
          showNavigator ? "md:left-[56px]" : "left-0"
        )}
      >
        <StudentViewer
          source={source}
          series={series}
          activeSeriesIndex={activeSeriesIndex}
          onSeriesChange={onSeriesChange}
          modality={caseData.modality}
          controls={s.controls}
          overlay={s.overlay}
          onReady={s.onViewerReady}
          marker={s.marker}
          markerVisible={
            s.markerVisible &&
            imagingResolved &&
            (!s.examMode || activeRevealed)
          }
          measurements={s.measurements}
          measurementsVisible={
            s.measurementsVisible &&
            imagingResolved &&
            (!s.examMode || activeRevealed)
          }
          replaying={s.replaying || s.pointing}
          ready={s.ready}
          locateMode={s.locateMode && imagingResolved}
          onLocateClick={s.onLocateClick}
          secondary={
            s.compareOpen
              ? {
                  source: compareSeries
                    ? caseSeriesToSource(compareSeries)
                    : source,
                  series: series.length > 0 ? series : undefined,
                  activeSeriesIndex: s.secondarySeriesIndex,
                  onSeriesChange: (uid) => {
                    const idx = series.findIndex((x) => x.seriesInstanceUID === uid);
                    if (idx >= 0) s.setSecondarySeriesIndex(idx);
                  },
                  controls: s.secondaryControls,
                  overlay: s.secondaryOverlay,
                  onReady: s.onSecondaryReady,
                  marker: s.secondaryMarker,
                  markerVisible:
                    s.secondaryMarkerVisible &&
                    imagingResolved &&
                    (!s.examMode || activeRevealed),
                  ready: s.secondaryReady,
                  instanceId: "compare",
                  label: "Compare",
                }
              : null
          }
        />
      </div>

      {showNavigator && (
        <div className="absolute bottom-0 left-0 top-0 z-20 hidden w-14 border-r border-subtle/60 bg-canvas/80 backdrop-blur md:block">
          <SeriesNavigator
            series={series}
            activeIndex={activeSeriesIndex}
            onSelect={(i) => {
              const uid = series[i]?.seriesInstanceUID;
              if (uid) onSeriesChange(uid);
            }}
          />
        </div>
      )}

      {/* Top HUD — above viewer chrome so Library is always clickable */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2">
          <a
            href="/library"
            className="inline-flex items-center rounded-md border border-subtle bg-elevated px-2.5 py-1.5 text-xs font-medium text-secondary hover:text-primary"
          >
            Library
          </a>
          <Badge variant="neutral" className="max-w-[14rem] truncate sm:max-w-xs">
            {caseData.title}
          </Badge>
          <Badge variant="neutral">{caseData.modality}</Badge>
          {stepLabel && (
            <Badge variant="accent" className="tabular-nums">
              Finding {stepLabel}
            </Badge>
          )}
          {intent === "exam" && s.vivaScore.total > 0 && (
            <Badge variant="neutral" className="tabular-nums">
              Located {s.vivaScore.located}/{s.vivaScore.total}
            </Badge>
          )}
        </div>
        <div className="pointer-events-auto flex items-center gap-1">
          <IconButton
            aria-label={s.compareOpen ? "Close compare" : "Open compare"}
            size="sm"
            variant={s.compareOpen ? "primary" : "secondary"}
            onClick={s.toggleCompare}
          >
            <Columns2 className="h-4 w-4" />
          </IconButton>
          <IconButton
            aria-label="Keyboard shortcuts"
            size="sm"
            variant="secondary"
            onClick={() => setKeysOpen(true)}
          >
            <Keyboard className="h-4 w-4" />
          </IconButton>
          <IconButton
            aria-label="Previous finding"
            size="sm"
            variant="secondary"
            disabled={!hasFindings || s.activeIndex <= 0 || s.busy}
            onClick={s.prev}
          >
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <IconButton
            aria-label="Next finding"
            size="sm"
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
            size="sm"
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

      <TutorCaption
        text={captionText}
        stepLabel={stepLabel}
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
      />

      {tutorVoice?.cloned && (
        <p className="pointer-events-none absolute inset-x-0 top-12 z-20 px-4 text-center text-[10px] text-muted/80 sm:top-14">
          Tutor voice is a synthetic clone modeled on {tutorVoice.authorName}.
        </p>
      )}

      {/* Bottom dock — above caption so Teach/Exam always receive clicks */}
      <div className="absolute inset-x-0 bottom-0 z-40 flex justify-center p-4">
        <div className="flex max-w-xl flex-col items-center gap-2">
          {hasFindings && (
            <div className="flex items-center gap-1.5" aria-label="Finding progress">
              {s.orderedFindings.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  aria-label={`Finding ${i + 1}`}
                  aria-current={i === s.activeIndex}
                  disabled={s.busy}
                  onClick={() => s.goTo(i)}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === s.activeIndex
                      ? "w-6 bg-accent"
                      : "w-1.5 bg-strong/70 hover:bg-accent/60"
                  )}
                />
              ))}
            </div>
          )}

          <div className="flex items-center gap-1 rounded-md border border-subtle bg-elevated p-1">
            <button
              type="button"
              onClick={() => setIntent("teach")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                intent === "teach"
                  ? "bg-accent text-accent-foreground"
                  : "text-secondary hover:text-primary"
              )}
            >
              Teach
            </button>
            <button
              type="button"
              onClick={() => setIntent("exam")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                intent === "exam"
                  ? "bg-accent text-accent-foreground"
                  : "text-secondary hover:text-primary"
              )}
            >
              Exam
            </button>
          </div>

          <div className="flex items-center gap-3 rounded-md border border-subtle bg-elevated px-4 py-2.5 shadow-md">
            <button
              type="button"
              onClick={openAsk}
              aria-label="Open tutor transcript"
              className="flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <AgentOrb state={s.orbState} level={s.micLevel} size="sm" />
              <span className="hidden text-xs font-medium text-secondary sm:inline">
                {ORB_TAGLINE[s.orbState]}
              </span>
            </button>
            <MicButton
              state={s.micState}
              onStart={s.onMicStart}
              onStop={s.onMicStop}
              disabled={!s.micSupported || (s.busy && s.micState === "idle")}
              label={
                s.micState === "recording"
                  ? "Release to send"
                  : s.micState === "processing"
                    ? "…"
                    : "Hold to speak"
              }
            />
            {intent === "teach" && !s.tourActive && s.ready && (
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<Play className="h-3.5 w-3.5" />}
                onClick={s.resumeTour}
                disabled={s.busy}
              >
                Continue
              </Button>
            )}
            {intent === "teach" && s.tourActive && s.phase === "speaking" && (
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<Pause className="h-3.5 w-3.5" />}
                onClick={() => {
                  s.pauseTour();
                  s.onStopSpeaking();
                }}
              >
                Pause
              </Button>
            )}
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
          <p className="text-[10px] text-muted">
            {dockHint} · <Kbd>?</Kbd> keys
          </p>
        </div>
      </div>

      <aside
        className={cn(
          "absolute bottom-0 right-0 top-0 z-40 flex w-full max-w-[380px] flex-col border-l border-subtle bg-surface/95 shadow-lg backdrop-blur transition-transform duration-300 md:w-[380px]",
          railOpen ? "translate-x-0" : "translate-x-full"
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

        <div className="border-b border-subtle px-3 py-2.5">
          <Tabs
            items={[
              { value: "guided", label: "Teach" },
              { value: "reporting", label: "Report" },
              { value: "socratic", label: "Socratic" },
              { value: "free", label: "Free" },
              { value: "viva", label: "Viva" },
            ]}
            value={mode}
            onValueChange={(v) => {
              const next = v as SessionMode;
              setMode(next);
              setPanel("ask");
              if (next === "reporting" || next === "guided" || next === "viva") {
                setRailOpen(true);
              }
            }}
          />
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
            series={series}
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
            turns={s.turns}
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
          />
        </div>
      </aside>

      <HotkeysOverlay open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}
