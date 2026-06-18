"use client";

// The AGENT ORB — a persistent, always-present avatar that visibly IS the
// tutor's state. It is the centerpiece of the student experience: one calm,
// clinical object that breathes when idle, listens with you, thinks, searches
// the web, and speaks.
//
// It maps the session's high-level OrbState (derived from phase + micState)
// onto on-brand motion built from the shared animation tokens (animate-spin /
// shimmer / mic-pulse / marker-pulse / pulse) plus a handful of truly dynamic
// per-element values (a bar's live height, a dot's orbit angle, the live mic
// level) — which CLAUDE.md §0 explicitly allows for computed values. No new
// CSS/keyframes are introduced; the JS-driven waveform keeps the motion alive
// without touching the design-system config.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";

/** The agent's visible mood. Derived in useStudentSession from phase+micState. */
export type OrbState =
  | "idle"
  | "listening"
  | "thinking"
  | "searching"
  | "speaking";

const SIZES = {
  // Docked over the viewer — compact but unmistakable.
  sm: { box: "h-14 w-14", core: "h-7 w-7", orbit: 26 },
  // Expanded into the tutor panel header — the hero.
  lg: { box: "h-24 w-24", core: "h-12 w-12", orbit: 46 },
} as const;

// Accent-derived halo per state. Listening borrows the danger/record hue so it
// reads as "live mic"; everything else stays on the single clinical accent.
const HALO: Record<OrbState, string> = {
  idle: "from-accent/25 via-accent/10 to-transparent",
  listening: "from-danger/35 via-danger/15 to-transparent",
  thinking: "from-accent/35 via-info/15 to-transparent",
  searching: "from-info/35 via-accent/15 to-transparent",
  speaking: "from-accent/40 via-accent/15 to-transparent",
};

const STATE_LABEL: Record<OrbState, string> = {
  idle: "Tutor ready",
  listening: "Listening to you",
  thinking: "Tutor is thinking",
  searching: "Searching medical sources",
  speaking: "Tutor is speaking",
};

export interface AgentOrbProps {
  state: OrbState;
  /** 0..1 live input level while listening (drives the pulse rings). */
  level?: number;
  size?: keyof typeof SIZES;
  className?: string;
}

/**
 * The orb. A soft radial halo, a breathing core, and a state-specific motion
 * layer (mic rings / shimmer sweep / orbiting dots / waveform). Decorative for
 * layout; exposes its mood to assistive tech via role + label.
 */
export function AgentOrb({ state, level = 0, size = "lg", className }: AgentOrbProps) {
  const sz = SIZES[size];
  const lvl = Math.max(0, Math.min(1, level));
  const large = size === "lg";

  return (
    <div
      role="img"
      aria-label={STATE_LABEL[state]}
      className={cn("relative flex items-center justify-center", sz.box, className)}
    >
      {/* Soft radial halo — breathes by default, intensifies per state. */}
      <span
        className={cn(
          "pointer-events-none absolute inset-[-30%] rounded-full blur-xl transition-opacity duration-500",
          "bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))]",
          HALO[state],
          state === "idle" ? "animate-pulse opacity-70" : "opacity-100"
        )}
        aria-hidden="true"
      />

      {/* Listening: a live-level ring that swells with your voice + the shared
          record pulse so it reads identically to the mic button. */}
      {state === "listening" && (
        <>
          <span
            className="pointer-events-none absolute inset-0 rounded-full border border-danger/50 transition-transform duration-100"
            style={{ transform: `scale(${1 + lvl * 0.45})`, opacity: 0.35 + lvl * 0.45 }}
            aria-hidden="true"
          />
          <span
            className="pointer-events-none absolute inset-0 animate-mic-pulse rounded-full"
            aria-hidden="true"
          />
        </>
      )}

      {/* Thinking: a slow shimmer sweep over a quiet ring. */}
      {state === "thinking" && (
        <span
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-full border border-accent/30"
          aria-hidden="true"
        >
          <span className="absolute inset-y-0 -left-full w-full animate-shimmer bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
        </span>
      )}

      {/* Searching the web: dots orbiting the core (grounding in progress). */}
      {state === "searching" && (
        <span className="pointer-events-none absolute inset-0 animate-spin [animation-duration:2.4s]" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-info shadow-[0_0_8px_rgb(var(--info))]"
              // Three dots evenly spaced on the orbit — angle is a dynamic value.
              style={{ transform: `rotate(${i * 120}deg) translateY(-${sz.orbit}px)` }}
            />
          ))}
        </span>
      )}

      {/* The core — a glassy disc. Speaking shows a live waveform; otherwise a
          calm dot so the agent always feels alive. */}
      <span
        className={cn(
          "relative flex items-center justify-center rounded-full border border-strong/60 shadow-md",
          "bg-gradient-to-br from-elevated to-surface",
          sz.core,
          state === "idle" && "animate-pulse"
        )}
        aria-hidden="true"
      >
        {state === "speaking" ? (
          <Waveform large={large} />
        ) : (
          <span
            className={cn(
              "rounded-full bg-accent shadow-[0_0_12px_rgb(var(--accent))]",
              large ? "h-3 w-3" : "h-2 w-2",
              (state === "thinking" || state === "searching") && "animate-marker-pulse"
            )}
          />
        )}
      </span>
    </div>
  );
}

/**
 * A live speaking waveform. Bar heights are recomputed on an interval (a truly
 * dynamic value), giving organic motion without adding CSS keyframes. Honors
 * prefers-reduced-motion by holding a static mid-height.
 */
function Waveform({ large }: { large: boolean }) {
  const count = large ? 5 : 3;
  const maxH = large ? 18 : 11;
  const [heights, setHeights] = useState<number[]>(() => Array(count).fill(maxH * 0.5));
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setHeights(Array(count).fill(maxH * 0.6));
      return;
    }
    let t = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 90) {
        last = now;
        t += 1;
        setHeights(
          Array.from({ length: count }, (_, i) => {
            const phase = t * 0.6 + i * 0.9;
            return Math.round((0.35 + 0.65 * Math.abs(Math.sin(phase))) * maxH);
          })
        );
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [count, maxH]);

  return (
    <span className="flex items-center gap-0.5" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className="w-0.5 rounded-full bg-accent transition-[height] duration-100 ease-out"
          style={{ height: `${h}px` }}
        />
      ))}
    </span>
  );
}
