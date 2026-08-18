"use client";

// Student teaching session — VIVA-first reading room.
//
// Product chrome is gone (AppShell reading-room mode). Full-bleed DICOM, an
// on-image examiner caption, a floating mic, progress dots. The rail is
// optional. Viva hides markers until the student attempts or asks to be shown.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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

type PanelTab = "lesson" | "ask";

const ORB_TAGLINE: Record<OrbState, string> = {
  idle: "Ready — hold mic or Space",
  listening: "Listening…",
  thinking: "Thinking…",
  searching: "Searching sources…",
  speaking: "Speaking…",
};

export default function StudentSession({
  caseData,
  source,
  series,
  manifest,
  imagingResolved,
}: {
  caseData: CaseData;
  source: ViewerSource;
  series: CaseSeries[];
  manifest: PrefetchManifest | null;
  imagingResolved: boolean;
}) {
  // Viva is the default examiner experience; guided keeps auto-advance.
  const [mode, setMode] = useState<SessionMode>("viva");
  const [panel, setPanel] = useState<PanelTab>("ask");
  const [railOpen, setRailOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const s = useStudentSession(caseData, mode, series);

  const openAsk = useCallback(() => {
    setRailOpen(true);
    setPanel("ask");
  }, []);

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
  });
  hotkeyRef.current = {
    busy: s.busy,
    recording: s.micState === "recording",
    start: s.onMicStart,
    stop: s.onMicStop,
  };
  useEffect(() => {
    if (!s.micSupported) return;
    const isTextTarget = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      if (typingRef.current || isTextTarget(e.target)) return;
      const h = hotkeyRef.current;
      if (h.busy || h.recording) return;
      e.preventDefault();
      heldRef.current = true;
      h.start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !heldRef.current) return;
      e.preventDefault();
      heldRef.current = false;
      hotkeyRef.current.stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [s.micSupported]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingRef.current) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setKeysOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") {
        if (keysOpen) {
          setKeysOpen(false);
          return;
        }
        setRailOpen(false);
        return;
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        setRailOpen((o) => !o);
      } else if (k === "c") {
        e.preventDefault();
        s.toggleCompare();
      } else if (k === "r") {
        e.preventDefault();
        s.revealCurrent();
      } else if (k === "n") {
        e.preventDefault();
        s.skip();
      } else if (k === "p") {
        e.preventDefault();
        s.prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysOpen, s]);

  const subtitle = useMemo(() => {
    const bits = [caseData.modality];
    if (caseData.specialty) bits.push(caseData.specialty);
    return bits.filter(Boolean).join(" · ");
  }, [caseData]);

  const hasFindings = s.orderedFindings.length > 0;
  const activeFinding =
    s.activeIndex >= 0 ? s.orderedFindings[s.activeIndex] : null;
  const activeRevealed = !!(
    activeFinding && s.revealedIds.includes(activeFinding.id)
  );
  const lastAssistant = [...s.turns].reverse().find((t) => t.role === "assistant" && !t.error);
  const captionText =
    s.locateHint ||
    lastAssistant?.text ||
    (s.locateMode
      ? "Click the finding on the image — or hold the mic and describe it."
      : "");
  const stepLabel = hasFindings
    ? s.examMode && !activeRevealed
      ? `${Math.max(s.activeIndex, 0) + 1}/${s.orderedFindings.length}`
      : activeFinding
        ? `${s.activeIndex + 1}/${s.orderedFindings.length}`
        : undefined
    : undefined;
  const compareSeries =
    series.length === 0
      ? undefined
      : series[
          Math.max(0, Math.min(series.length - 1, s.secondarySeriesIndex))
        ];

  return (
    <div className="relative h-screen bg-imaging">
      {/* Full-bleed imaging */}
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

      {/* Collapsed series strip */}
      {showNavigator && (
        <div className="absolute bottom-0 left-0 top-0 z-20 hidden w-14 border-r border-subtle/60 bg-canvas/80 backdrop-blur md:block">
          <SeriesNavigator
            series={series}
            activeIndex={activeSeriesIndex}
            onSelect={setActiveSeriesIndex}
            className="h-full"
          />
        </div>
      )}

      {/* Top HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          <Link
            href="/library"
            className="rounded-md border border-strong/50 bg-elevated/85 px-2 py-1 text-[11px] font-medium text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            Library
          </Link>
          <Badge variant="neutral">{caseData.title}</Badge>
          {subtitle && <Badge variant="accent">{subtitle}</Badge>}
          {!imagingResolved && <Badge variant="warning">Sample imaging</Badge>}
          {hasFindings && (
            <Badge variant="accent" dot>
              {s.examMode && !activeRevealed
                ? `Finding ${Math.max(s.activeIndex, 0) + 1} of ${s.orderedFindings.length}`
                : activeFinding
                  ? `${s.activeIndex + 1}/${s.orderedFindings.length} · ${activeFinding.label}`
                  : `${s.orderedFindings.length} findings`}
            </Badge>
          )}
          {s.compareOpen && <Badge variant="accent">Compare</Badge>}
          {s.locateMode && <Badge variant="warning">Locate</Badge>}
        </div>
        <div className="pointer-events-auto flex items-center gap-1.5">
          <IconButton
            aria-label={s.compareOpen ? "Close compare view" : "Open compare view"}
            aria-pressed={s.compareOpen}
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
        revealed={activeRevealed}
        sources={lastAssistant?.sources}
      />

      {/* Bottom viva dock — the composition: orb + mic + progress */}
      <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center p-4">
        <div className="flex max-w-xl flex-col items-center gap-2">
          {hasFindings && (
            <div className="flex items-center gap-1.5" aria-label="Finding progress">
              {s.orderedFindings.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  aria-label={
                    s.examMode && !s.revealedIds.includes(f.id)
                      ? `Finding ${i + 1}`
                      : `Finding ${i + 1}: ${f.label}`
                  }
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
          <div className="flex items-center gap-3 rounded-2xl border border-strong/50 bg-elevated/90 px-4 py-2.5 shadow-lg backdrop-blur">
            <button
              type="button"
              onClick={openAsk}
              aria-label="Open tutor transcript"
              className="flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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
            {s.locateMode
              ? "Click the image to locate · Space to talk · ? keys"
              : (
                <>
                  Examiner viva · <Kbd>Space</Kbd> to talk · <Kbd>?</Kbd> keys
                </>
              )}
          </p>
        </div>
      </div>

      {/* Collapsible tutor rail */}
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
            <h2 className="truncate text-sm font-semibold text-primary">Examiner</h2>
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
              { value: "viva", label: "Viva" },
              { value: "guided", label: "Guided" },
              { value: "socratic", label: "Socratic" },
              { value: "free", label: "Free" },
              { value: "reporting", label: "Report" },
            ]}
            value={mode}
            onValueChange={(v) => setMode(v as SessionMode)}
          />
        </div>

        <div className="border-b border-subtle px-3 py-2">
          <Tabs
            variant="underline"
            items={[
              {
                value: "lesson",
                label: "Lesson",
                icon: <GraduationCap className="h-4 w-4" aria-hidden="true" />,
                count: hasFindings ? s.orderedFindings.length : undefined,
              },
              {
                value: "ask",
                label: "Viva chat",
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
          />
        </div>
      </aside>

      <HotkeysOverlay open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}
