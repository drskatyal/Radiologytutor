"use client";

// The student teaching session: viewer (left) + tutor rail/chat (right). A
// guided, multi-step finding walk-through driven through our self-hosted
// Cornerstone viewer, with voice Q&A — fronted by a persistent AGENT ORB that
// visibly IS the tutor's state. The page resolves the DICOM source + prefetch
// manifest server-side and hands them in; we warm the cache in the background
// (never blocking render) and drive the viewer per finding.
//
// Two orbs, one agent: a small orb DOCKED over the viewer (always in view while
// you study the image) and the hero orb in the tutor panel header. Both read
// the same orbState, so the agent feels like one continuous presence.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GraduationCap, MessageCircle } from "lucide-react";
import { Badge, Tabs } from "@/components/ui";
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

/** The two faces of the tutor panel: the lesson spine vs. the Q&A chat. */
type PanelTab = "lesson" | "ask";

const ORB_TAGLINE: Record<OrbState, string> = {
  idle: "Ready when you are",
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
  /** The case's series rail (multi-series). Single entry = single-series case. */
  series: CaseSeries[];
  manifest: PrefetchManifest | null;
  /** True when the case's own study resolved from Orthanc (vs a sample image). */
  imagingResolved: boolean;
}) {
  const [mode, setMode] = useState<SessionMode>("guided");
  // Which face of the tutor panel is showing: the lesson cards (the spine) or
  // the Q&A chat. The cards are the lesson; "Ask" opens the chat without losing
  // your place — both share the same agent (orb + voice).
  const [panel, setPanel] = useState<PanelTab>("lesson");
  const s = useStudentSession(caseData, mode);

  // Jump to the Ask tab and focus the conversation. Used by the "Ask the tutor"
  // affordance under the cards and by the docked orb over the viewer.
  const openAsk = useCallback(() => setPanel("ask"), []);

  // The series currently in the viewport. Driven by the navigator (user click)
  // and by replay (a recorded `series` event calls onSeriesChange below).
  const [activeSeriesIndex, setActiveSeriesIndex] = useState(0);
  const onSeriesChange = useCallback(
    (uid: string) => {
      const idx = series.findIndex((x) => x.seriesInstanceUID === uid);
      if (idx >= 0) setActiveSeriesIndex(idx);
    },
    [series]
  );
  const showNavigator = series.length > 1;

  // While the student is typing, disarm the push-to-talk hotkey so a space in
  // their question never starts the mic.
  const typingRef = useRef(false);
  const onTypingFocus = useCallback(() => {
    typingRef.current = true;
    s.onStopSpeaking();
  }, [s]);
  const onTypingBlur = useCallback(() => {
    typingRef.current = false;
  }, []);

  // Background cache warming once the manifest is known. Idle/low-priority;
  // never blocks the viewer render (CLAUDE.md §4a).
  useEffect(() => {
    if (manifest?.hasImaging) warmPrefetch(manifest);
  }, [manifest]);

  // Push-to-talk hotkey: hold Space (when not typing / not busy) to record,
  // release to send. Ignored while a text field or button has focus. Volatile
  // reads go through a ref so we bind the listeners exactly once.
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

  return (
    <div
      className={cn(
        "grid h-[calc(100vh-49px)] grid-cols-1",
        showNavigator
          ? "md:grid-cols-[200px_1fr_400px]"
          : "md:grid-cols-[1fr_400px]"
      )}
    >
      {/* Series rail (PACS navigator) — only when the case has >1 series. */}
      {showNavigator && (
        <SeriesNavigator
          series={series}
          activeIndex={activeSeriesIndex}
          onSelect={setActiveSeriesIndex}
          className="hidden border-r md:flex"
        />
      )}

      {/* Imaging stage */}
      <section className="relative min-h-0 bg-imaging">
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
          // Markers belong to the real study — never paint them on a sample.
          markerVisible={s.markerVisible && imagingResolved}
          replaying={s.replaying}
          ready={s.ready}
        />

        {/* Floating case label — top-right so it clears the viewer toolbar. */}
        <div className="pointer-events-none absolute right-4 top-4 flex animate-fade-up flex-wrap items-center justify-end gap-2">
          <Badge variant="neutral">{caseData.title}</Badge>
          {subtitle && <Badge variant="accent">{subtitle}</Badge>}
          {!imagingResolved && <Badge variant="warning">Sample imaging</Badge>}
        </div>

        {/* Docked agent orb — always-present over the image. Tapping it opens
            the Ask tab (the orb visibly IS the assistant you talk to). */}
        <button
          type="button"
          onClick={openAsk}
          aria-label="Ask the AI tutor"
          className="absolute bottom-4 left-4 flex animate-fade-in items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <AgentOrb state={s.orbState} level={s.micLevel} size="sm" />
          <span className="rounded-full border border-subtle bg-surface/80 px-2.5 py-1 text-xs font-medium text-secondary backdrop-blur-sm tabular-nums">
            {ORB_TAGLINE[s.orbState]}
          </span>
        </button>
      </section>

      {/* Tutor side rail */}
      <aside className="flex min-h-0 flex-col border-t border-subtle bg-surface md:border-l md:border-t-0">
        {/* Hero header — the agent orb + mode switch. */}
        <div className="flex items-center gap-3 border-b border-subtle p-4">
          <AgentOrb state={s.orbState} level={s.micLevel} size="lg" className="shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-primary">AI Tutor</h2>
            <p className="truncate text-xs text-muted">{ORB_TAGLINE[s.orbState]}</p>
          </div>
        </div>

        {/* Teaching mode (how the tutor answers). */}
        <div className="border-b border-subtle px-4 py-3">
          <Tabs
            items={[
              { value: "guided", label: "Guided" },
              { value: "socratic", label: "Socratic" },
              { value: "free", label: "Free" },
              { value: "reporting", label: "Reporting" },
            ]}
            value={mode}
            onValueChange={(v) => setMode(v as SessionMode)}
          />
        </div>

        {/* Lesson vs. Ask — the cards are the spine; Ask is the Q&A chat. */}
        <div className="border-b border-subtle px-4 py-2.5">
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
                label: "Ask",
                icon: <MessageCircle className="h-4 w-4" aria-hidden="true" />,
              },
            ]}
            value={panel}
            onValueChange={(v) => setPanel(v as PanelTab)}
          />
        </div>

        {/* Lesson spine — the finding cards. Kept mounted so a playing card and
            scroll position survive a hop over to Ask and back. */}
        <div className={cn("min-h-0 flex-1 flex-col", panel === "lesson" ? "flex" : "hidden")}>
          <FindingCards
            findings={s.orderedFindings}
            series={series}
            caseModality={caseData.modality}
            activeIndex={s.activeIndex}
            replaying={s.replaying}
            busy={s.busy}
            ready={s.ready}
            onSelect={s.goTo}
          />
          {hasFindings && (
            <div className="border-t border-subtle p-4">
              <button
                type="button"
                onClick={openAsk}
                className={cn(
                  "flex w-full items-center justify-center gap-2 rounded-lg border border-subtle bg-elevated/60 px-3 py-2.5 text-sm font-medium text-secondary transition-colors",
                  "hover:border-accent/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                )}
              >
                <MessageCircle className="h-4 w-4" aria-hidden="true" />
                Ask the tutor a question
              </button>
            </div>
          )}
        </div>

        {/* Q&A chat — always mounted (preserves transcript + audio); shown on Ask. */}
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
