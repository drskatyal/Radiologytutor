"use client";
import { Input } from "@/components/ui";
import { retainedMarkers } from "@/lib/anchors/resolve";
import type { RecordedTrack } from "@/lib/types";
/** Explicit exception for an editor whose save target is one existing finding. */
export function MarkerGroupChoice({ track, checked, onChange }: { track: RecordedTrack | null; checked: boolean; onChange: (value: boolean) => void }) {
  const markers = retainedMarkers(track?.journal ?? []);
  if (markers.length < 2) return null;
  return <div className="space-y-2 rounded-lg border border-subtle bg-surface p-3">
    <p className="text-sm text-secondary">This take contains {markers.length} retained markers. Speak once creates separate candidates for them.</p>
    <label className="flex items-start gap-2 text-sm text-primary">
      <Input type="checkbox" className="mt-1 h-4 w-4 shrink-0 p-0 accent-accent" checked={checked} onChange={e => onChange(e.target.checked)} />
      Group all {markers.length} markers as views of this one finding.
    </label>
  </div>;
}
