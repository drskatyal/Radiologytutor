"use client";

// Normalized finding marker rendered over the viewer. Position is stored as
// [0,1] percentages (lib/types Marker) so it's resolution-independent; only the
// computed left/top use inline style (allowed for truly dynamic values per
// CLAUDE.md §0). Pulses with the accent token; fades in on reveal.

import { ArrowDown } from "lucide-react";
import { cn } from "@/components/ui";
import type { Marker } from "@/lib/types";

export function FindingMarker({
  marker,
  visible,
}: {
  marker: Marker;
  visible: boolean;
}) {
  // Dynamic position only — everything else is Tailwind tokens.
  const position = { left: `${marker.x_pct * 100}%`, top: `${marker.y_pct * 100}%` };

  if (marker.shape === "arrow") {
    return (
      <div
        className={cn(
          "pointer-events-none absolute -translate-x-1/2 -translate-y-full transition-all duration-500 ease-out",
          visible ? "opacity-100 translate-y-[-100%]" : "translate-y-[-80%] opacity-0"
        )}
        style={position}
        aria-hidden="true"
      >
        <ArrowDown
          className="h-9 w-7 text-accent drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent transition-opacity duration-500 ease-out",
        visible ? "animate-marker-pulse opacity-100" : "opacity-0"
      )}
      style={position}
      aria-hidden="true"
    />
  );
}
