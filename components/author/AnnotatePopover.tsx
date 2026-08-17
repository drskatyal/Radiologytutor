"use client";

// Click-to-annotate popover — the fast authoring loop:
//   click on the finding → popover opens at the click → dictate with mic →
//   Gemini structures JSON into the fields → author confirms & saves.
//
// Positions use normalized [0,1] markers; only left/top use inline style
// (CLAUDE.md §0). Uses design-system MicButton / Field / Input / Button.

import { useEffect, useRef, useState } from "react";
import { Check, MapPin, X } from "lucide-react";
import {
  Button,
  Field,
  IconButton,
  Input,
  MicButton,
  Spinner,
  Textarea,
  type MicState,
} from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { Marker, MarkerShape, StructuredFinding } from "@/lib/types";
import { LIMITS } from "@/components/author/lib";

export interface AnnotatePopoverProps {
  marker: Marker;
  draft: StructuredFinding;
  onDraftChange: (next: StructuredFinding) => void;
  micState: MicState;
  micSupported: boolean;
  structuring: boolean;
  saving: boolean;
  notice?: string;
  onMicStart: () => void;
  onMicStop: () => void;
  onShapeChange: (shape: MarkerShape) => void;
  onSave: () => void;
  onCancel: () => void;
  /** Optional transcript preview after STT (before/while structuring). */
  transcript?: string;
}

/**
 * Floating capture card anchored near the click. Keeps the imaging surface
 * readable — compact, one job: capture this finding.
 */
export function AnnotatePopover({
  marker,
  draft,
  onDraftChange,
  micState,
  micSupported,
  structuring,
  saving,
  notice,
  onMicStart,
  onMicStop,
  onShapeChange,
  onSave,
  onCancel,
  transcript,
}: AnnotatePopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState(false);

  // Flip the panel so it stays inside the imaging square.
  const preferLeft = marker.x_pct > 0.55;
  const preferAbove = marker.y_pct > 0.55;

  useEffect(() => {
    // Focus the label once the popover mounts so keyboard users can edit fast.
    const id = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const canSave = !!draft.label.trim() && !saving && !structuring;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-40"
      aria-live="polite"
    >
      {/* Provisional marker at the click. */}
      <span
        className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent shadow-[0_0_0_4px_rgb(var(--accent)/0.2)]"
        style={{ left: `${marker.x_pct * 100}%`, top: `${marker.y_pct * 100}%` }}
        aria-hidden="true"
      />

      {/* Anchor + panel */}
      <div
        className={cn(
          "pointer-events-auto absolute w-[min(22rem,calc(100%-1.5rem))] transition-opacity duration-200",
          placed ? "opacity-100" : "opacity-0",
          preferLeft ? "-translate-x-full" : "",
          preferAbove ? "-translate-y-full" : ""
        )}
        style={{
          left: `${marker.x_pct * 100}%`,
          top: `${marker.y_pct * 100}%`,
          marginLeft: preferLeft ? -12 : 12,
          marginTop: preferAbove ? -12 : 12,
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Annotate finding"
          className="animate-fade-up overflow-hidden rounded-xl border border-strong/70 bg-elevated/95 shadow-lg backdrop-blur"
        >
          <div className="flex items-center justify-between gap-2 border-b border-subtle px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-medium text-secondary">
              <MapPin className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              <span>
                Mark @ {(marker.x_pct * 100).toFixed(0)}%,{" "}
                {(marker.y_pct * 100).toFixed(0)}%
              </span>
            </div>
            <IconButton
              aria-label="Cancel annotation"
              size="sm"
              variant="ghost"
              onClick={onCancel}
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>

          <div className="flex flex-col gap-3 p-3">
            {/* Dictate first — the radiologist's fast path. */}
            <div className="rounded-lg border border-subtle bg-surface/80 px-3 py-2.5">
              <MicButton
                state={micState}
                onStart={onMicStart}
                onStop={onMicStop}
                disabled={!micSupported || structuring || saving}
                label={
                  micState === "recording"
                    ? "Dictating finding…"
                    : micState === "processing" || structuring
                      ? "Structuring with AI…"
                      : "Dictate finding"
                }
              />
              <p className="mt-1.5 text-[11px] leading-snug text-muted">
                Speak the finding — Gemini fills label, description, and teaching
                points. Edit anything before saving.
              </p>
            </div>

            {transcript && (
              <p className="rounded-md border border-subtle bg-canvas/40 px-2.5 py-1.5 text-[11px] italic text-secondary">
                “{transcript}”
              </p>
            )}

            {notice && (
              <p className="text-[11px] text-secondary">{notice}</p>
            )}

            {(structuring || micState === "processing") && (
              <div className="flex items-center gap-2 text-xs text-secondary">
                <Spinner size="sm" />
                Structuring dictation…
              </div>
            )}

            <div className="flex gap-1.5">
              <ShapeChip
                active={marker.shape === "circle"}
                label="Circle"
                onClick={() => onShapeChange("circle")}
              />
              <ShapeChip
                active={marker.shape === "arrow"}
                label="Arrow"
                onClick={() => onShapeChange("arrow")}
              />
            </div>

            <Field label="Label" required>
              {(p) => (
                <Input
                  {...p}
                  autoFocus
                  placeholder="e.g. ACL tear"
                  value={draft.label}
                  maxLength={LIMITS.label}
                  onChange={(e) =>
                    onDraftChange({ ...draft, label: e.target.value })
                  }
                />
              )}
            </Field>

            <Field label="Description">
              {(p) => (
                <Textarea
                  {...p}
                  rows={2}
                  placeholder="What the learner should see…"
                  value={draft.description}
                  maxLength={LIMITS.description}
                  onChange={(e) =>
                    onDraftChange({ ...draft, description: e.target.value })
                  }
                />
              )}
            </Field>

            <Field label="Teaching points">
              {(p) => (
                <Textarea
                  {...p}
                  rows={2}
                  placeholder="One point per line"
                  value={draft.teachingPoints.join("\n")}
                  onChange={(e) =>
                    onDraftChange({
                      ...draft,
                      teachingPoints: e.target.value
                        .split("\n")
                        .map((s) => s.trimEnd())
                        .slice(0, LIMITS.teachingPoints),
                    })
                  }
                />
              )}
            </Field>

            <div className="flex items-center gap-2 pt-0.5">
              <Button
                size="sm"
                className="flex-1"
                leadingIcon={<Check className="h-3.5 w-3.5" />}
                onClick={onSave}
                loading={saving}
                disabled={!canSave}
              >
                Save finding
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShapeChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        active
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-subtle bg-surface text-secondary hover:border-strong hover:text-primary"
      )}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
