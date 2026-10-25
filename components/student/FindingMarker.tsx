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
          className="h-9 w-7 text-accent drop-shadow-[0_0_1px_#000] drop-shadow-[0_1px_2px_#000]"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </div>
    );
  }

  return (
      <div
        className={cn(
          "pointer-events-none absolute h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_#000,0_0_0_4px_rgb(var(--accent))] transition-opacity duration-500 ease-out",
          visible ? "opacity-100" : "opacity-0"
        )}
        style={position}
        aria-hidden="true"
      >
        {visible && (
          <span className="absolute inset-0 animate-marker-pulse rounded-full" />
        )}
        <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_1px_#000]" />
      </div>
  );
}
