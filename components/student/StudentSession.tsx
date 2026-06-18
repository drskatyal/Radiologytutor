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
import { Badge, EmptyState, Tabs } from "@/components/ui";
import type { CaseData } from "@/lib/types";
import type { ViewerSource } from "@/lib/viewerSource";
import type { PrefetchManifest } from "@/lib/prefetch";
import { StudentViewer } from "./StudentViewer";
import { StepRail } from "./StepRail";
import { TutorChat } from "./TutorChat";
import { AgentOrb, type OrbState } from "./AgentOrb";
import { useStudentSession, type SessionMode } from "./useStudentSession";
import { warmPrefetch } from "./prefetch";

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
  manifest,
  imagingResolved,
}: {
  caseData: CaseData;
  source: ViewerSource;
  manifest: PrefetchManifest | null;
  /** True when the case's own study resolved from Orthanc (vs a sample image). */
  imagingResolved: boolean;
}) {
  const [mode, setMode] = useState<SessionMode>("guided");
  const s = useStudentSession(caseData, mode);

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
    <div className="grid h-[calc(100vh-49px)] grid-cols-1 md:grid-cols-[1fr_400px]">
      {/* Imaging stage */}
      <section className="relative min-h-0 bg-imaging">
        <StudentViewer
          source={source}
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

        {/* Docked agent orb — always-present over the image. Tapping it focuses
            the tutor (mobile-friendly hint that this thing is the assistant). */}
        <div className="absolute bottom-4 left-4 flex animate-fade-in items-center gap-2.5">
          <AgentOrb state={s.orbState} level={s.micLevel} size="sm" />
          <span className="rounded-full border border-subtle bg-surface/80 px-2.5 py-1 text-xs font-medium text-secondary backdrop-blur-sm tabular-nums">
            {ORB_TAGLINE[s.orbState]}
          </span>
        </div>
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

        {hasFindings ? (
          <StepRail
            findings={s.orderedFindings}
            activeIndex={s.activeIndex}
            busy={s.busy || !s.ready}
            onPrev={s.prev}
            onNext={s.next}
            onJump={s.goTo}
          />
        ) : (
          <div className="border-b border-subtle p-4">
            <EmptyState
              title="No findings yet"
              description="This case doesn’t have a guided walk-through. You can still ask the tutor anything about the study below."
            />
          </div>
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
        />
      </aside>
    </div>
  );
}
