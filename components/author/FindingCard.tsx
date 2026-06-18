"use client";

// One finding, as an editable card. Shows the structured output (label,
// description, teachingPoints[]) in a clean form plus a read-only summary of
// the viewer/marker state. Editing is inline with explicit Save/Cancel; saving
// is optimistic (the parent applies the returned case + toasts).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Badge,
  Card,
  IconButton,
  Field,
  Input,
  Textarea,
  cn,
} from "@/components/ui";
import type { Finding, StructuredFinding } from "@/lib/types";
import {
  draftsDiffer,
  hasErrors,
  normalizeDraft,
  toDraft,
  validateDraft,
  type FindingDraft,
} from "./lib";
import { RestructureDialog } from "./RestructureDialog";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CheckIcon,
  CloseIcon,
  GripIcon,
  LayersIcon,
  PencilIcon,
  PlusIcon,
  SparkleIcon,
  TargetIcon,
  TrashIcon,
} from "./icons";

interface FindingCardProps {
  finding: Finding;
  index: number;
  total: number;
  /** Persist structured edits; resolves when saved (parent toasts/rolls back). */
  onSave: (findingId: string, patch: Partial<Finding>) => Promise<void>;
  onDelete: (findingId: string) => void;
  onMove: (findingId: string, dir: -1 | 1) => void;
  /** Drag handlers (HTML5 DnD) wired by the parent list. */
  dragging?: boolean;
  dropTarget?: boolean;
  onDragStart?: () => void;
  onDragEnter?: () => void;
  onDragEnd?: () => void;
}

export function FindingCard({
  finding,
  index,
  total,
  onSave,
  onDelete,
  onMove,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: FindingCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FindingDraft>(() => toDraft(finding));
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [showRestructure, setShowRestructure] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);

  const original = useMemo(() => toDraft(finding), [finding]);

  // Keep the draft in sync if the finding changes underneath us while not
  // actively editing (e.g. a reorder refreshes the case).
  useEffect(() => {
    if (!editing) setDraft(toDraft(finding));
  }, [finding, editing]);

  const errors = validateDraft(draft);
  const dirty = draftsDiffer(draft, original);
  const hasFlow = (finding.keyframes?.length ?? 0) > 1;

  function startEdit() {
    setDraft(toDraft(finding));
    setEditing(true);
    requestAnimationFrame(() => labelRef.current?.focus());
  }

  function cancelEdit() {
    setDraft(toDraft(finding));
    setEditing(false);
  }

  async function commit() {
    const clean = normalizeDraft(draft);
    if (hasErrors(validateDraft(clean))) return;
    setSaving(true);
    try {
      await onSave(finding.id, clean);
      setEditing(false);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1200);
    } finally {
      setSaving(false);
    }
  }

  function applyProposal(next: StructuredFinding) {
    // Drop into edit mode pre-filled with the AI proposal; the author reviews
    // and presses Save to persist (one consistent save path).
    setDraft({
      label: next.label,
      description: next.description,
      teachingPoints: [...next.teachingPoints],
    });
    setEditing(true);
    requestAnimationFrame(() => labelRef.current?.focus());
  }

  // --- teaching point editing ---------------------------------------------
  function setPoint(i: number, value: string) {
    setDraft((d) => ({
      ...d,
      teachingPoints: d.teachingPoints.map((p, idx) => (idx === i ? value : p)),
    }));
  }
  function addPoint() {
    setDraft((d) => ({ ...d, teachingPoints: [...d.teachingPoints, ""] }));
  }
  function removePoint(i: number) {
    setDraft((d) => ({
      ...d,
      teachingPoints: d.teachingPoints.filter((_, idx) => idx !== i),
    }));
  }

  return (
    <Card
      padded={false}
      className={cn(
        "group/card animate-fade-up overflow-hidden transition-all duration-200",
        "hover:border-strong hover:shadow-md",
        editing && "border-accent/40 ring-1 ring-accent/20",
        justSaved && "border-success/50 ring-1 ring-success/30",
        dragging && "scale-[0.99] opacity-60",
        dropTarget && "border-accent/60 ring-2 ring-accent/30"
      )}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Header: order, drag handle, label, controls */}
      <div className="flex items-start gap-3 border-b border-subtle px-4 py-3">
        <div
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-label="Drag to reorder"
          title="Drag to reorder"
          className={cn(
            "mt-0.5 flex cursor-grab touch-none items-center text-muted transition-colors active:cursor-grabbing hover:text-secondary",
            "[&_svg]:h-4 [&_svg]:w-4"
          )}
        >
          <GripIcon />
        </div>

        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-xs font-semibold tabular-nums text-accent">
          {index + 1}
        </span>

        <div className="min-w-0 flex-1">
          {editing ? (
            <Field error={errors.label} className="gap-1">
              {(p) => (
                <Input
                  {...p}
                  ref={labelRef}
                  className="h-9"
                  placeholder="Finding label (e.g. ACL tear)"
                  value={draft.label}
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") cancelEdit();
                  }}
                />
              )}
            </Field>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-primary">
                {finding.label || "Untitled finding"}
              </h3>
              {hasFlow && (
                <Badge variant="info" title={`${finding.keyframes!.length} keyframes`}>
                  <LayersIcon />
                  Flow · {finding.keyframes!.length}
                </Badge>
              )}
              {justSaved && (
                <Badge variant="success" className="animate-fade-in">
                  <CheckIcon />
                  Saved
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* reorder + edit controls */}
        {!editing && (
          <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover/card:opacity-100">
            <IconButton
              size="sm"
              aria-label="Move finding up"
              disabled={index === 0}
              onClick={() => onMove(finding.id, -1)}
            >
              <ChevronUpIcon />
            </IconButton>
            <IconButton
              size="sm"
              aria-label="Move finding down"
              disabled={index === total - 1}
              onClick={() => onMove(finding.id, 1)}
            >
              <ChevronDownIcon />
            </IconButton>
            <span className="mx-0.5 h-5 w-px bg-subtle" />
            <IconButton size="sm" aria-label="Edit finding" onClick={startEdit}>
              <PencilIcon />
            </IconButton>
            <IconButton
              size="sm"
              variant="danger"
              aria-label="Delete finding"
              onClick={() => onDelete(finding.id)}
            >
              <TrashIcon />
            </IconButton>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="space-y-4 px-4 py-4">
        {editing ? (
          <>
            <Field label="Description">
              {(p) => (
                <Textarea
                  {...p}
                  rows={3}
                  placeholder="One or two sentences describing the finding…"
                  value={draft.description}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, description: e.target.value }))
                  }
                />
              )}
            </Field>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-secondary">
                  Teaching points
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<PlusIcon />}
                  onClick={addPoint}
                >
                  Add point
                </Button>
              </div>
              {draft.teachingPoints.length === 0 ? (
                <p className="rounded-lg border border-dashed border-strong px-3 py-2.5 text-xs text-muted">
                  No teaching points yet. Add a concise associated sign or pearl.
                </p>
              ) : (
                <ul className="space-y-2">
                  {draft.teachingPoints.map((pt, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-elevated text-[10px] font-semibold tabular-nums text-muted">
                        {i + 1}
                      </span>
                      <Input
                        className="h-9 text-sm"
                        placeholder="Teaching point…"
                        value={pt}
                        aria-label={`Teaching point ${i + 1}`}
                        onChange={(e) => setPoint(i, e.target.value)}
                      />
                      <IconButton
                        size="sm"
                        variant="danger"
                        aria-label={`Remove teaching point ${i + 1}`}
                        onClick={() => removePoint(i)}
                      >
                        <CloseIcon />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-subtle pt-3">
              <Button
                size="sm"
                onClick={commit}
                loading={saving}
                disabled={hasErrors(errors) || (!dirty && !saving)}
                leadingIcon={!saving ? <CheckIcon /> : undefined}
              >
                Save changes
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
                Cancel
              </Button>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<SparkleIcon />}
                onClick={() => setShowRestructure(true)}
                disabled={saving}
              >
                Re-run AI
              </Button>
            </div>
          </>
        ) : (
          <>
            {finding.description ? (
              <p className="text-sm leading-relaxed text-secondary">
                {finding.description}
              </p>
            ) : (
              <p className="text-sm italic text-muted">No description yet.</p>
            )}

            {finding.teachingPoints.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Teaching points
                </p>
                <ul className="space-y-1.5">
                  {finding.teachingPoints.map((pt, i) => (
                    <li
                      key={i}
                      className="flex gap-2 text-sm leading-relaxed text-secondary"
                    >
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
                      {pt}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <ViewerSummary finding={finding} />

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<PencilIcon />}
                onClick={startEdit}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<SparkleIcon />}
                onClick={() => setShowRestructure(true)}
              >
                Re-run AI structuring
              </Button>
            </div>
          </>
        )}
      </div>

      <RestructureDialog
        open={showRestructure}
        onClose={() => setShowRestructure(false)}
        current={editing ? draft : original}
        onApply={applyProposal}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------

/** Read-only summary of the finding's marker + viewer/keyframe state. */
function ViewerSummary({ finding }: { finding: Finding }) {
  const mx = Math.round(finding.marker.x_pct * 100);
  const my = Math.round(finding.marker.y_pct * 100);
  const kf = finding.keyframes?.length ?? (finding.state ? 1 : 0);
  const dur = finding.durationMs ? (finding.durationMs / 1000).toFixed(1) : null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-surface/60 px-3 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        Viewer
      </span>
      <Badge variant="neutral" title="Marker position (normalized)">
        <TargetIcon />
        {finding.marker.shape} @ {mx}%, {my}%
      </Badge>
      <Badge variant="neutral" title="Captured keyframes">
        <LayersIcon />
        {kf} keyframe{kf === 1 ? "" : "s"}
      </Badge>
      {dur && (
        <Badge variant="neutral" title="Flow duration">
          {dur}s flow
        </Badge>
      )}
      {!finding.state && (
        <Badge variant="warning">No viewer state captured</Badge>
      )}
    </div>
  );
}
