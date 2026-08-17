"use client";

// Student teaching session — VIVA-first reading room.
//
// Default chrome is collapsed: full-bleed DICOM, a floating mic, progress dots,
// and an examiner AI that speaks while driving the viewer. The side rail is
// optional (lesson cards / transcript) and starts collapsed so the image stays
// the composition. Guided/viva auto-advances to the next finding after the
// tutor finishes speaking (barge-in cancels).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  MessageCircle,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { Badge, IconButton, MicButton, Tabs } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { CaseData } from "@/lib/types";
import type { CaseSeries, ViewerSource } from "@/lib/viewerSource";
import type { PrefetchManifest } from "@/lib/prefetch";
import { StudentViewer } from "./StudentViewer";
import { FindingCards } from "./FindingCards";
import { TutorChat } from "./TutorChat";
import { AgentOrb, type OrbState } from "./AgentOrb";
import { useStudentSession, type SessionMode } from "./useStudentSession";
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
  const s = useStudentSession(caseData, mode);

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

  const subtitle = useMemo(() => {
    const bits = [caseData.modality];
    if (caseData.specialty) bits.push(caseData.specialty);
    return bits.filter(Boolean).join(" · ");
  }, [caseData]);

  const hasFindings = s.orderedFindings.length > 0;
  const activeFinding =
    s.activeIndex >= 0 ? s.orderedFindings[s.activeIndex] : null;

  return (
    <div className="relative h-[calc(100vh-49px)] bg-imaging">
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
          markerVisible={s.markerVisible && imagingResolved}
          replaying={s.replaying || s.pointing}
          ready={s.ready}
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
          <Badge variant="neutral">{caseData.title}</Badge>
          {subtitle && <Badge variant="accent">{subtitle}</Badge>}
          {!imagingResolved && <Badge variant="warning">Sample imaging</Badge>}
          {activeFinding && (
            <Badge variant="accent" dot>
              {s.activeIndex + 1}/{s.orderedFindings.length} · {activeFinding.label}
            </Badge>
          )}
        </div>
        <div className="pointer-events-auto flex items-center gap-1.5">
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
            onClick={s.next}
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

      {/* Bottom viva dock — the composition: orb + mic + progress */}
      <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center p-4">
        <div className="flex max-w-xl flex-col items-center gap-2">
          {hasFindings && (
            <div className="flex items-center gap-1.5" aria-label="Finding progress">
              {s.orderedFindings.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  aria-label={`Finding ${i + 1}: ${f.label}`}
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
          </div>
          <p className="text-[10px] text-muted">
            Examiner viva · Space to talk · web-grounded questions welcome
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
    </div>
  );
}
