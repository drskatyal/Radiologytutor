"use client";

// /record — the record → replay demo on the BUNDLED sample (no Gemini/Orthanc
// needed). Hold Alt+X to record: scroll, window/level, zoom/pan, and move the
// cursor; release to stop; hit Replay to watch the EXACT retrace with the laser
// pointer, locked to your narration audio. This proves the whole mechanic end
// to end with zero backend.

import { useRef, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { BUNDLED_CASE } from "@/lib/viewerSource";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ReplayOverlayHandle } from "@/components/ReplayOverlay";
import { RecordStage } from "@/components/record/RecordStage";
import { useRecordReplay } from "@/components/record/useRecordReplay";

export default function RecordDemoPage() {
  const controls = useRef<CornerstoneControls | null>(null);
  const overlay = useRef<ReplayOverlayHandle | null>(null);
  const [ready, setReady] = useState(false);

  const rr = useRecordReplay({ controls, overlay, ready });

  const onReady = (c: CornerstoneControls) => {
    controls.current = c;
    setReady(true);
  };

  const hasTrack = !!rr.track && rr.track.events.length > 0;
  const eventCount = rr.track?.events.length ?? 0;
  const durationSec = rr.track ? (rr.track.durationMs / 1000).toFixed(1) : "0.0";

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Record & Replay"
        description="Hold Alt+X to record a narrated walk-through, release to stop, then replay the exact retrace."
        actions={
          <div className="flex items-center gap-2">
            {!rr.supported && <Badge variant="warning">Mic unavailable — events still record</Badge>}
            {rr.phase === "recording" && (
              <Badge variant="danger" dot>
                Recording
              </Badge>
            )}
          </div>
        }
      />

      <div className="mx-auto grid max-w-6xl gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Stage */}
        <div className="min-w-0">
          <RecordStage
            source={BUNDLED_CASE}
            modality="MR"
            controls={controls}
            overlay={overlay}
            ready={ready}
            phase={rr.phase}
            elapsedMs={rr.elapsedMs}
            progress={rr.progress}
            onReady={onReady}
            onEvent={rr.onViewerEvent}
            onCursor={rr.onCursor}
          />
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-4">
          <Card padded={false} className="p-4">
            <h2 className="text-sm font-semibold text-primary">Controls</h2>
            <div className="mt-3 flex flex-col gap-2">
              {rr.phase === "recording" ? (
                <Button variant="danger" onClick={() => rr.stopRecording()}>
                  Stop recording
                </Button>
              ) : rr.phase === "replaying" ? (
                <Button variant="secondary" onClick={rr.stopReplay}>
                  Stop replay
                </Button>
              ) : (
                <Button onClick={() => rr.startRecording()} disabled={!ready} leadingIcon={<DotIcon />}>
                  Start recording
                </Button>
              )}

              <Button
                variant="secondary"
                onClick={() => rr.replay()}
                disabled={!hasTrack || rr.phase !== "idle"}
                leadingIcon={<PlayIcon />}
              >
                Replay recording
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={rr.reset}
                disabled={!hasTrack || rr.phase !== "idle"}
              >
                Discard
              </Button>
            </div>

            <p className="mt-3 text-xs text-muted">
              Tip: hold{" "}
              <kbd className="rounded border border-strong bg-elevated px-1.5 py-0.5 text-[11px] font-medium text-secondary">
                Alt
              </kbd>{" "}
              +{" "}
              <kbd className="rounded border border-strong bg-elevated px-1.5 py-0.5 text-[11px] font-medium text-secondary">
                X
              </kbd>{" "}
              to record, release to stop.
            </p>
          </Card>

          <Card padded={false} className="p-4">
            <h2 className="text-sm font-semibold text-primary">Last recording</h2>
            {hasTrack ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted">Duration</dt>
                <dd className="text-right tabular-nums text-primary">{durationSec}s</dd>
                <dt className="text-muted">Events</dt>
                <dd className="text-right tabular-nums text-primary">{eventCount}</dd>
                <dt className="text-muted">Narration</dt>
                <dd className="text-right text-primary">{rr.audio ? "captured" : "silent"}</dd>
              </dl>
            ) : (
              <div className="mt-3">
                <EmptyState
                  title="Nothing recorded yet"
                  description="Hold Alt+X and move around the viewer, then release."
                />
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function DotIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
