"use client";

// Pre-save readout for a one-take walk-through. The beat list is the script
// Teach will play; alignment is only known after transcription, so that lands
// on the save toast.

import type { RecordedTrack } from "@/lib/types";
import { recordedGuidePreview } from "@/lib/teachingGuide";

export function RecordedTakeNote({
  track,
  hasAudio,
  replacesDemo = false,
  point,
}: {
  track: RecordedTrack;
  hasAudio: boolean;
  replacesDemo?: boolean;
  /** Marker the save will store, so the commit beat is counted before save. */
  point?: { x: number; y: number };
}) {
  const preview = recordedGuidePreview(track, point ? { point } : undefined);
  const acts = preview.acts.join(" → ");
  return (
    <div className="rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-secondary">
      <p>
        <span className="font-medium tabular-nums text-primary">
          {preview.beatCount} teach {preview.beatCount === 1 ? "beat" : "beats"}
        </span>
        {acts ? <span className="text-muted"> · {acts}</span> : null}
      </p>
      <p className="mt-1 leading-relaxed">
        {hasAudio
          ? "Save transcribes the microphone onto this script."
          : "No microphone on this take. Save still builds the script from the gestures and the notes you type."}
        {preview.shortTrack ? " Short take — Teach keeps the gestures you recorded." : ""}
        {replacesDemo ? " This replaces the demo tour." : ""}
      </p>
    </div>
  );
}
