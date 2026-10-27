"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";

const LINES = [
  "Start at the carina.",
  "The nodule is in the right upper lobe.",
  "Then the mediastinum, same study.",
];

const SLICES = ["Carina", "Nodule", "Mediastinum"];

/**
 * A teaching card: stacked frames, a black film window, and the attending line
 * on the white surface under the window.
 */
export function TeachStage({ compact = false }: { compact?: boolean }) {
  const [line, setLine] = useState(0);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) return;
    const id = window.setInterval(() => {
      setLine((current) => (current + 1) % LINES.length);
    }, 3200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={cn("relative w-full", compact ? "max-w-md pt-6" : "max-w-xl pt-8")} aria-hidden="true">
      <div className="absolute inset-x-8 top-0 h-16 rounded-2xl border border-strong bg-overlay motion-safe:animate-slice-drift" />
      <div className="absolute inset-x-4 top-2 h-16 rounded-2xl border border-subtle bg-surface" />
      <div className={cn("relative rounded-2xl border border-subtle bg-surface p-2 shadow-md", compact ? "mt-6" : "mt-8")}>
        <div className="flex items-center justify-between px-2 py-2">
          <p className="text-sm font-semibold text-accent">Lung windows</p>
          <p className="text-sm font-semibold tabular-nums text-secondary">
            {line + 34} / 65
            <span className="ml-3">W 1500</span>
            <span className="ml-3">L −600</span>
          </p>
        </div>
        <div className={cn("relative overflow-hidden rounded-lg bg-imaging", compact ? "aspect-[4/3]" : "aspect-[16/10]")}>
          <svg viewBox="0 0 320 200" className="h-full w-full" fill="none">
            <ellipse cx="162" cy="104" rx="108" ry="72" fill="#3A3A3A" />
            <ellipse cx="154" cy="100" rx="78" ry="50" fill="#555555" />
            <ellipse cx="196" cy="88" rx="26" ry="16" fill="#737373" />
            <ellipse cx="124" cy="124" rx="16" ry="12" fill="#2A2A2A" />
          </svg>
          <span className="absolute left-[58%] top-[36%] rounded-md bg-accent px-2 py-1 text-xs font-semibold text-white">
            {SLICES[line]}
          </span>
        </div>
        <div className="flex items-center gap-3 px-2 py-3">
          <span className="flex h-4 items-end gap-1">
            {[0, 1, 2, 3, 4].map((bar) => (
              <span
                key={bar}
                className="h-4 w-0.5 origin-bottom rounded-full bg-accent motion-safe:animate-voice-level"
                style={{ animationDelay: `${bar * 80}ms` }}
              />
            ))}
          </span>
          <p className="min-w-0 text-sm font-semibold text-primary text-pretty">{LINES[line]}</p>
        </div>
      </div>
    </div>
  );
}
