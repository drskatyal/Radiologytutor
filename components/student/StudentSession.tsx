"use client";

// The student teaching session: viewer (left) + tutor rail/chat (right). A
// guided, multi-step finding walk-through driven through our self-hosted
// Cornerstone viewer, with voice Q&A. The page resolves the DICOM source +
// prefetch manifest server-side and hands them in; we warm the cache in the
// background (never blocking render) and drive the viewer per finding.

import { useEffect, useMemo, useState } from "react";
import { Badge, Tabs } from "@/components/ui";
import type { CaseData } from "@/lib/types";
import type { ViewerSource } from "@/lib/viewerSource";
import type { PrefetchManifest } from "@/lib/prefetch";
import { StudentViewer } from "./StudentViewer";
import { StepRail } from "./StepRail";
import { TutorChat } from "./TutorChat";
import { useStudentSession, type SessionMode } from "./useStudentSession";
import { warmPrefetch } from "./prefetch";

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

  // Background cache warming once the manifest is known. Idle/low-priority;
  // never blocks the viewer render (CLAUDE.md §4a).
  useEffect(() => {
    if (manifest?.hasImaging) warmPrefetch(manifest);
  }, [manifest]);

  const subtitle = useMemo(() => {
    const bits = [caseData.modality];
    if (caseData.specialty) bits.push(caseData.specialty);
    return bits.filter(Boolean).join(" · ");
  }, [caseData]);

  return (
    <div className="grid h-[calc(100vh-49px)] grid-cols-1 md:grid-cols-[1fr_400px]">
      {/* Imaging stage */}
      <section className="relative min-h-0 bg-imaging">
        <StudentViewer
          source={source}
          controls={s.controls}
          onReady={s.onViewerReady}
          marker={s.marker}
          // Markers belong to the real study — never paint them on a sample.
          markerVisible={s.markerVisible && imagingResolved}
          ready={s.ready}
        />
        {/* Floating case label — top-right so it clears the viewer toolbar. */}
        <div className="pointer-events-none absolute right-4 top-4 flex animate-fade-up flex-wrap items-center justify-end gap-2">
          <Badge variant="neutral">{caseData.title}</Badge>
          {subtitle && <Badge variant="accent">{subtitle}</Badge>}
          {!imagingResolved && <Badge variant="warning">Sample imaging</Badge>}
        </div>
      </section>

      {/* Tutor side rail */}
      <aside className="flex min-h-0 flex-col border-t border-subtle bg-surface md:border-l md:border-t-0">
        <div className="flex items-center justify-between gap-3 border-b border-subtle p-4">
          <h2 className="truncate text-sm font-semibold text-primary">AI Tutor</h2>
          <Tabs
            items={[
              { value: "guided", label: "Guided" },
              { value: "socratic", label: "Socratic" },
              { value: "free", label: "Free" },
            ]}
            value={mode}
            onValueChange={(v) => setMode(v as SessionMode)}
          />
        </div>

        <StepRail
          findings={s.orderedFindings}
          activeIndex={s.activeIndex}
          busy={s.busy || !s.ready}
          onPrev={s.prev}
          onNext={s.next}
          onJump={s.goTo}
        />

        <TutorChat
          turns={s.turns}
          phase={s.phase}
          micState={s.micState}
          micSupported={s.micSupported}
          busy={s.busy}
          onSend={s.sendText}
          onMicStart={s.onMicStart}
          onMicStop={s.onMicStop}
          onStopSpeaking={s.onStopSpeaking}
        />
      </aside>
    </div>
  );
}
