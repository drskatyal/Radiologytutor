"use client";

// Re-run Gemini structuring for a finding. Flow:
//   1. paste/dictate notes  ->  2. POST /api/structure-finding
//   3. preview the result as a field-by-field DIFF against the current draft
//   4. apply (replaces the finding's structured fields) or discard.
// The dialog only proposes; applying is the caller's job (optimistic save).

import { useEffect, useState } from "react";
import {
  Button,
  Badge,
  Field,
  Textarea,
  Modal,
  Spinner,
  cn,
} from "@/components/ui";
import type { StructuredFinding } from "@/lib/types";
import { structureFinding, type FindingDraft } from "./lib";
import { SparkleIcon } from "./icons";

interface RestructureDialogProps {
  open: boolean;
  onClose: () => void;
  /** The finding's current structured fields, to diff the proposal against. */
  current: FindingDraft;
  /** Called with the AI proposal when the author applies it. */
  onApply: (next: StructuredFinding) => void;
}

export function RestructureDialog({
  open,
  onClose,
  current,
  onApply,
}: RestructureDialogProps) {
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<StructuredFinding | null>(null);

  // Reset every time the dialog opens so each run starts clean.
  useEffect(() => {
    if (open) {
      setTranscript("");
      setBusy(false);
      setError("");
      setProposal(null);
    }
  }, [open]);

  async function run() {
    if (!transcript.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await structureFinding(transcript.trim());
      setProposal(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to structure");
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (proposal) onApply(proposal);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Re-run AI structuring"
      description="Paste or dictate the radiologist's notes — Gemini structures them into a label, description and teaching points. Review the diff before applying."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {proposal ? (
            <Button onClick={apply} leadingIcon={<SparkleIcon />}>
              Apply to finding
            </Button>
          ) : (
            <Button
              onClick={run}
              loading={busy}
              disabled={!transcript.trim()}
              leadingIcon={!busy ? <SparkleIcon /> : undefined}
            >
              {busy ? "Structuring…" : "Structure with AI"}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Dictation / notes"
          hint="Free text — e.g. 'Sagittal, ACL tear at the femoral attachment, complete fibre discontinuity, teaching point empty notch sign.'"
        >
          {(p) => (
            <Textarea
              {...p}
              rows={4}
              autoFocus
              placeholder="Describe the finding in your own words…"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              disabled={busy}
            />
          )}
        </Field>

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        {busy && (
          <div className="flex items-center gap-3 rounded-xl border border-subtle bg-surface px-4 py-3 text-sm text-secondary">
            <Spinner size="sm" />
            Structuring the finding…
          </div>
        )}

        {proposal && !busy && (
          <div className="animate-fade-up space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                Proposed changes
              </span>
              <span className="h-px flex-1 bg-subtle" />
            </div>
            <DiffRow label="Label" before={current.label} after={proposal.label} />
            <DiffRow
              label="Description"
              before={current.description}
              after={proposal.description}
            />
            <ListDiffRow
              label="Teaching points"
              before={current.teachingPoints}
              after={proposal.teachingPoints}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function DiffRow({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  const changed = (before ?? "").trim() !== (after ?? "").trim();
  return (
    <div className="rounded-xl border border-subtle bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium text-secondary">{label}</span>
        {changed ? (
          <Badge variant="accent">Changed</Badge>
        ) : (
          <Badge variant="neutral">Unchanged</Badge>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <DiffCell tone="before" text={before} />
        <DiffCell tone="after" text={after} highlight={changed} />
      </div>
    </div>
  );
}

function ListDiffRow({
  label,
  before,
  after,
}: {
  label: string;
  before: string[];
  after: string[];
}) {
  const changed = before.join("") !== after.join("");
  return (
    <div className="rounded-xl border border-subtle bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium text-secondary">{label}</span>
        {changed ? (
          <Badge variant="accent">Changed</Badge>
        ) : (
          <Badge variant="neutral">Unchanged</Badge>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <ListDiffCell tone="before" items={before} />
        <ListDiffCell tone="after" items={after} highlight={changed} />
      </div>
    </div>
  );
}

function cellTone(tone: "before" | "after", highlight?: boolean): string {
  if (tone === "before") return "border-subtle bg-canvas/60 text-muted";
  return highlight
    ? "border-accent/40 bg-accent/10 text-primary"
    : "border-subtle bg-canvas/60 text-secondary";
}

function DiffCell({
  tone,
  text,
  highlight,
}: {
  tone: "before" | "after";
  text: string;
  highlight?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border p-2.5", cellTone(tone, highlight))}>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">
        {tone === "before" ? "Current" : "Proposed"}
      </p>
      <p className="text-xs leading-relaxed">
        {text?.trim() ? text : <span className="italic opacity-60">— empty —</span>}
      </p>
    </div>
  );
}

function ListDiffCell({
  tone,
  items,
  highlight,
}: {
  tone: "before" | "after";
  items: string[];
  highlight?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border p-2.5", cellTone(tone, highlight))}>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">
        {tone === "before" ? "Current" : "Proposed"}
      </p>
      {items.length === 0 ? (
        <p className="text-xs italic leading-relaxed opacity-60">— none —</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it, i) => (
            <li key={i} className="flex gap-1.5 text-xs leading-relaxed">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
              {it}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
