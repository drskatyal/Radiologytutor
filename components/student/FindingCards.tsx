"use client";

// The lesson spine: findings as cards. Play seats the viewer on that finding
// so the AI tutor can teach it — capture tracks arm the model; they are not a tape.

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  Crosshair,
  Layers,
  Loader2,
  Pause,
  Play,
  Sparkles,
} from "lucide-react";
import { Badge, EmptyState, cn } from "@/components/ui";
import type { CaseSeries } from "@/lib/viewerSource";
import type { Finding } from "@/lib/types";

// A teaser is the finding's first sentence (or a trimmed lead) — enough to
// promise what the card teaches without spilling the whole note.
function teaserOf(finding: Finding): string {
  const src = finding.description?.trim() || finding.teachingPoints?.[0]?.trim() || "";
  if (!src) return "Open to explore this finding.";
  const firstSentence = src.split(/(?<=[.!?])\s+/)[0] ?? src;
  return firstSentence.length > 120 ? `${firstSentence.slice(0, 117).trimEnd()}…` : firstSentence;
}

// Description bodies over this length collapse behind a "Read more" toggle so a
// card teaches without becoming a wall of text.
const DESCRIPTION_CLAMP = 320;

export function FindingCards({
  findings,
  series,
  caseModality,
  activeIndex,
  replaying,
  busy,
  ready,
  onSelect,
  examMode = false,
  revealedIds = [],
}: {
  findings: Finding[];
  /** The case's series rail — used to label each card's anchored series. */
  series: CaseSeries[];
  /** Fallback modality when a finding isn't anchored to a specific series. */
  caseModality: string;
  /** Index of the finding currently revealed in the viewer, or -1. */
  activeIndex: number;
  /** True while the active finding is being driven (laser / transition). */
  replaying: boolean;
  /** Viewer is mid-transition / a call is in flight — cards report intent only. */
  busy: boolean;
  /** Viewer is ready to be driven. */
  ready: boolean;
  /** Ask the parent to seat a finding in the viewer. */
  onSelect: (index: number) => void;
  /** Oral exam: hide labels until the examiner has shown that finding. */
  examMode?: boolean;
  revealedIds?: string[];
}) {
  // Which card the student has manually expanded; the active card is always
  // expanded implicitly (see `expanded` below).
  const [openId, setOpenId] = useState<string | null>(null);

  // Quick lookup of a series by UID so each card can show its anchored badge.
  const seriesByUid = useMemo(() => {
    const map = new Map<string, CaseSeries>();
    for (const s of series) map.set(s.seriesInstanceUID, s);
    return map;
  }, [series]);

  if (findings.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon={<Crosshair />}
          title="No findings yet"
          description="This case doesn’t have a guided walk-through. Switch to the Ask tab to ask the tutor anything about the study."
        />
      </div>
    );
  }

  const total = findings.length;
  const current = activeIndex < 0 ? 0 : activeIndex + 1;

  return (
    <div className="flex min-h-0 flex-col">
      {/* Lesson header — progress + an animated spine. */}
      <div className="flex flex-col gap-2.5 border-b border-subtle p-4">
        <div className="flex items-center justify-between">
          <Badge variant="accent" dot>
            Finding {activeIndex < 0 ? "—" : current} of {total}
          </Badge>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            {examMode ? "Oral exam" : "Guided lesson"}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
          {/* Width is a truly-dynamic value (inline ok per CLAUDE.md §0). */}
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
            style={{ width: `${total > 0 ? (current / total) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* The card stack. */}
      <ol className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
        {findings.map((finding, i) => {
          const active = i === activeIndex;
          const expanded = active || openId === finding.id;
          const anchored = finding.seriesInstanceUID
            ? seriesByUid.get(finding.seriesInstanceUID)
            : undefined;
          const hasAudio = !!finding.track?.audioUrl;
          const playing = active && replaying;

          const spoiler = examMode && !revealedIds.includes(finding.id);
          return (
            <li key={finding.id}>
              <FindingCard
                index={i}
                finding={finding}
                active={active}
                expanded={spoiler ? false : expanded}
                playing={playing}
                hasAudio={hasAudio}
                modality={anchored?.modality || caseModality}
                seriesLabel={
                  anchored?.description?.trim() ||
                  (anchored?.seriesNumber != null ? `Series ${anchored.seriesNumber}` : undefined)
                }
                disabled={busy || !ready}
                onToggle={() => {
                  if (spoiler) {
                    onSelect(i);
                    return;
                  }
                  setOpenId((cur) => (cur === finding.id ? null : finding.id));
                }}
                onPlay={() => onSelect(i)}
                teaser={spoiler ? "Answer first — label hidden until revealed." : teaserOf(finding)}
                spoiler={spoiler}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FindingCard({
  index,
  finding,
  active,
  expanded,
  playing,
  hasAudio,
  modality,
  seriesLabel,
  disabled,
  teaser,
  spoiler = false,
  onToggle,
  onPlay,
}: {
  index: number;
  finding: Finding;
  active: boolean;
  expanded: boolean;
  playing: boolean;
  hasAudio: boolean;
  modality: string;
  seriesLabel?: string;
  disabled: boolean;
  teaser: string;
  spoiler?: boolean;
  onToggle: () => void;
  onPlay: () => void;
}) {
  const bodyId = `finding-body-${finding.id}`;

  return (
    <div
      className={cn(
        "group relative rounded-xl border shadow-sm transition-colors",
        active
          ? "border-accent/50 bg-accent/5"
          : "border-subtle bg-elevated hover:border-strong"
      )}
    >
      {/* Header row — the label toggles expand; Play is a separate control. */}
      <div className="flex items-start gap-3 p-3">
        {/* Number / status chip. */}
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors",
            active ? "bg-accent text-accent-foreground" : "bg-surface text-muted"
          )}
          aria-hidden="true"
        >
          {index + 1}
        </span>

        {/* Label + teaser + meta — clicking expands/collapses the note. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className={cn(
            "min-w-0 flex-1 rounded-md text-left",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-semibold",
                active ? "text-primary" : "text-secondary group-hover:text-primary"
              )}
            >
              {spoiler ? `Finding ${index + 1}` : finding.label}
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted transition-transform duration-200",
                expanded && "rotate-180"
              )}
              aria-hidden="true"
            />
          </div>

          {/* Meta line: anchored series + modality badge. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={active ? "accent" : "neutral"}>{modality}</Badge>
            {seriesLabel && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                <Layers className="h-3 w-3" aria-hidden="true" />
                <span className="max-w-[10rem] truncate">{seriesLabel}</span>
              </span>
            )}
          </div>

          {/* One-line teaser — hidden once expanded (the full note replaces it). */}
          {!expanded && (
            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted">
              {teaser}
            </p>
          )}
        </button>

        {/* Play / retrace control. */}
        <PlayControl
          playing={playing}
          hasAudio={hasAudio}
          disabled={disabled}
          onClick={onPlay}
          label={spoiler ? `Finding ${index + 1}` : finding.label}
        />
      </div>

      {/* Expanded teaching note. */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={bodyId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <TeachingNote finding={finding} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Show-in-viewer control — seats the finding so the tutor can teach it.
function PlayControl({
  playing,
  hasAudio,
  disabled,
  label,
  onClick,
}: {
  playing: boolean;
  hasAudio: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={
        playing ? `Stop driving to ${label}` : `Show ${label} in the viewer`
      }
      className={cn(
        "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        "disabled:cursor-not-allowed disabled:opacity-40",
        playing
          ? "border-accent bg-accent text-accent-foreground"
          : "border-strong bg-surface text-secondary hover:border-accent/50 hover:text-primary"
      )}
    >
      {playing ? (
        <Pause className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true" />
      ) : (
        <Play className="h-3.5 w-3.5 translate-x-px" fill="currentColor" aria-hidden="true" />
      )}
    </button>
  );
}

// The calibrated teaching note: a lead description, then bulleted pearls. Long
// descriptions truncate behind a "Read more" toggle so the card stays scannable.
function TeachingNote({ finding }: { finding: Finding }) {
  const [showFull, setShowFull] = useState(false);
  const description = finding.description?.trim() ?? "";
  const isLong = description.length > DESCRIPTION_CLAMP;
  const shown =
    isLong && !showFull
      ? `${description.slice(0, DESCRIPTION_CLAMP).trimEnd()}…`
      : description;
  const pearls = (finding.teachingPoints ?? []).map((p) => p.trim()).filter(Boolean);
  const hasContent = !!description || pearls.length > 0;

  return (
    <div className="space-y-3 px-3 pb-3.5 pl-[3.25rem]">
      {description && (
        <div>
          <p className="text-sm leading-relaxed text-secondary">{shown}</p>
          {isLong && (
            <button
              type="button"
              onClick={() => setShowFull((v) => !v)}
              className="mt-1 rounded text-xs font-medium text-accent underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {showFull ? "Show less" : "Read more"}
            </button>
          )}
        </div>
      )}

      {pearls.length > 0 && (
        <div>
          <p className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <Sparkles className="h-3 w-3 text-accent" aria-hidden="true" />
            Teaching pearls
          </p>
          <ul className="space-y-1.5">
            {pearls.map((point, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-secondary">
                <span
                  className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  aria-hidden="true"
                />
                <span className="min-w-0">{point}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!hasContent && (
        <p className="text-sm italic leading-relaxed text-muted">
          No teaching note recorded for this finding yet — press play to view it in the viewer.
        </p>
      )}
    </div>
  );
}

// A shimmer skeleton stack for the lesson panel while the session warms up.
export function FindingCardsSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 p-4" aria-hidden="true">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-3 rounded-xl border border-subtle bg-elevated/50 p-3"
        >
          <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-elevated" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-elevated" />
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-elevated" />
            <div className="h-2.5 w-5/6 animate-pulse rounded bg-elevated" />
          </div>
          <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-muted" />
        </div>
      ))}
    </div>
  );
}
