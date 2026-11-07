"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";

/**
 * Axial chest CT stills for the teaching card. Mediastinum reuses the carina
 * acquisition, cropped tighter and a stop darker — there is no third slice.
 */
export const TEACH_BEATS = [
  {
    id: "carina",
    label: "Carina",
    slice: 34,
    line: "Start at the carina.",
    src: "/brand/hero-carina.jpg",
    imageClass: "object-center",
  },
  {
    id: "nodule",
    label: "Nodule",
    slice: 41,
    line: "The nodule is in the right upper lobe.",
    src: "/brand/hero-nodule.jpg",
    imageClass: "object-center",
  },
  {
    id: "mediastinum",
    label: "Mediastinum",
    slice: 52,
    line: "Then the mediastinum, same study.",
    src: "/brand/hero-carina.jpg",
    imageClass: "origin-center scale-125 object-center brightness-[0.78]",
  },
] as const;

/**
 * A teaching card: stacked frames, a black film window, and the attending line
 * on the white surface under the window. The window is a photograph. The
 * header, finding pill, and spoken line stay live HTML.
 */
export function TeachStage({ compact = false }: { compact?: boolean }) {
  const [line, setLine] = useState(0);
  const beat = TEACH_BEATS[line] ?? TEACH_BEATS[0];

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) return;
    const id = window.setInterval(() => {
      setLine((current) => (current + 1) % TEACH_BEATS.length);
    }, 3200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={cn("relative w-full", compact ? "max-w-md pt-6" : "max-w-xl pt-8")} aria-hidden="true">
      <div className="absolute inset-x-8 top-0 h-16 rounded-2xl border border-strong bg-overlay motion-safe:animate-slice-drift" />
      <div className="absolute inset-x-4 top-2 h-16 rounded-2xl border border-subtle bg-surface" />
      <div className={cn("relative rounded-2xl border border-subtle bg-surface p-3 shadow-md", compact ? "mt-6" : "mt-8")}>
        <div className="flex items-start justify-between gap-3 px-1 pb-3 pt-1">
          <div className="min-w-0">
            <p className={cn("font-semibold tracking-tight text-primary", compact ? "text-sm" : "text-base")}>
              Lung windows
            </p>
            <p className="mt-0.5 text-sm tabular-nums text-secondary">
              {beat.slice}/65 • W 1500 L −600
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground">
            {beat.label}
          </span>
        </div>
        <div className={cn("relative overflow-hidden rounded-lg bg-imaging", compact ? "aspect-[4/3]" : "aspect-[16/10]")}>
          {TEACH_BEATS.map((frame, index) => (
            <img
              key={frame.id}
              src={frame.src}
              alt=""
              width={1280}
              height={720}
              draggable={false}
              className={cn(
                "absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-draw motion-reduce:transition-none",
                frame.imageClass,
                index === line ? "z-10 opacity-100" : "pointer-events-none opacity-0"
              )}
            />
          ))}
        </div>
        <div className="flex items-center gap-3 px-1 pb-1 pt-3">
          <span className="flex h-4 items-end gap-1">
            {[0, 1, 2, 3, 4].map((bar) => (
              <span
                key={bar}
                className="h-4 w-0.5 origin-bottom rounded-full bg-accent motion-safe:animate-voice-level"
                style={{ animationDelay: `${bar * 80}ms` }}
              />
            ))}
          </span>
          <p className="min-w-0 text-sm font-semibold text-primary text-pretty">{beat.line}</p>
        </div>
      </div>
    </div>
  );
}
