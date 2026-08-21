"use client";

// Add a new finding to a case. The author dictates/pastes notes; Gemini
// structures them into { label, description, teachingPoints }, which the author
// reviews and can edit before creating. A placeholder marker (centre) and an
// optional pasted viewer `state` are attached so the finding is valid; the
// per-finding viewer capture flow refines the marker/keyframes afterwards.

import { useEffect, useState } from "react";
import {
  Button,
  Badge,
  Field,
  Input,
  Textarea,
  Modal,
  Spinner,
  cn,
} from "@/components/ui";
import type { Finding, StructuredFinding } from "@/lib/types";
import { extractState } from "@/lib/pacsbinUrl";
import { AiUnavailableError, LIMITS, structureFinding } from "./lib";
import { SparkleIcon, PlusIcon, CloseIcon, CheckIcon } from "./icons";

interface AddFindingDialogProps {
  open: boolean;
  onClose: () => void;
  /** Append the finding; resolves when created (parent toasts/refreshes). */
  onCreate: (finding: Partial<Finding>) => Promise<void>;
}

const EMPTY: StructuredFinding = { label: "", description: "", teachingPoints: [] };

export function AddFindingDialog({ open, onClose, onCreate }: AddFindingDialogProps) {
  const [transcript, setTranscript] = useState("");
  const [structuring, setStructuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<StructuredFinding>(EMPTY);
  const [viewerUrl, setViewerUrl] = useState("");
  const [structured, setStructured] = useState(false);

  useEffect(() => {
    if (open) {
      setTranscript("");
      setStructuring(false);
      setSaving(false);
      setError("");
      setNotice("");
      setDraft(EMPTY);
      setViewerUrl("");
      setStructured(false);
    }
  }, [open]);

  async function structure() {
    if (!transcript.trim()) return;
    setStructuring(true);
    setError("");
    setNotice("");
    try {
      const result = await structureFinding(transcript.trim());
      setDraft(result);
      setStructured(true);
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        // No Gemini key — never a dead end. Seed the description with the raw
        // notes so nothing is lost and let them edit the fields by hand.
        setDraft((d) => ({
          ...d,
          description: d.description.trim() ? d.description : transcript.trim(),
        }));
        setNotice(
          "AI structuring is off (no Gemini key). Your notes are kept below — edit the fields and add a label to save."
        );
      } else {
        setError(e instanceof Error ? e.message : "Failed to structure");
      }
    } finally {
      setStructuring(false);
    }
  }

  async function create() {
    if (!draft.label.trim()) {
      setError("A label is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const state = extractState(viewerUrl.trim());
      await onCreate({
        label: draft.label.trim(),
        description: draft.description.trim(),
        teachingPoints: draft.teachingPoints.map((p) => p.trim()).filter(Boolean),
        // A finding needs a state + marker to be valid; default to a centre
        // marker and (optionally) a pasted state. Refined in the capture flow.
        state: state || " ",
        marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create finding");
    } finally {
      setSaving(false);
    }
  }

  function setPoint(i: number, v: string) {
    setDraft((d) => ({
      ...d,
      teachingPoints: d.teachingPoints.map((p, idx) => (idx === i ? v : p)),
    }));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Add a finding"
      description="Dictate or paste your notes and let AI structure them — or fill the fields in directly."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={create}
            loading={saving}
            disabled={!draft.label.trim()}
            leadingIcon={!saving ? <CheckIcon /> : undefined}
          >
            Add finding
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* AI structuring */}
        <div className="rounded-xl border border-subtle bg-surface p-3">
          <Field
            label="Dictation / notes (optional)"
            hint="Gemini turns this into a label, description and teaching points."
          >
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                placeholder="e.g. Sagittal, ACL tear at the femoral attachment…"
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                disabled={structuring}
              />
            )}
          </Field>
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={structure}
              loading={structuring}
              disabled={!transcript.trim()}
              leadingIcon={!structuring ? <SparkleIcon /> : undefined}
            >
              {structuring ? "Structuring…" : "Structure with AI"}
            </Button>
            {structured && (
              <Badge variant="success" className="animate-fade-in">
                <CheckIcon />
                Structured — review below
              </Badge>
            )}
          </div>
        </div>

        {notice && (
          <p className="rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-secondary">
            {notice}
          </p>
        )}

        {structuring && (
          <div className="flex items-center gap-3 rounded-xl border border-subtle bg-surface px-4 py-3 text-sm text-secondary">
            <Spinner size="sm" />
            Structuring the finding…
          </div>
        )}

        {/* Structured fields (editable) */}
        <div
          className={cn(
            "space-y-3 transition-opacity",
            structuring && "pointer-events-none opacity-50"
          )}
        >
          <Field label="Label" required error={error && !draft.label.trim() ? error : undefined}>
            {(p) => (
              <Input
                {...p}
                placeholder="Short finding name (e.g. ACL tear)"
                value={draft.label}
                maxLength={LIMITS.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              />
            )}
          </Field>
          <Field label="Description">
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                placeholder="One or two sentences describing the finding…"
                value={draft.description}
                maxLength={LIMITS.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            )}
          </Field>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-secondary">Teaching points</span>
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<PlusIcon />}
                disabled={draft.teachingPoints.length >= LIMITS.teachingPoints}
                onClick={() =>
                  setDraft((d) => ({ ...d, teachingPoints: [...d.teachingPoints, ""] }))
                }
              >
                Add point
              </Button>
            </div>
            {draft.teachingPoints.length === 0 ? (
              <p className="rounded-lg border border-dashed border-strong px-3 py-2.5 text-xs text-muted">
                No teaching points yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {draft.teachingPoints.map((pt, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Input
                      className="h-9 text-sm"
                      placeholder="Teaching point…"
                      aria-label={`Teaching point ${i + 1}`}
                      value={pt}
                      maxLength={LIMITS.teachingPoint}
                      onChange={(e) => setPoint(i, e.target.value)}
                    />
                    <IconClose
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          teachingPoints: d.teachingPoints.filter((_, idx) => idx !== i),
                        }))
                      }
                      label={`Remove teaching point ${i + 1}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Field
            label="Viewer state URL (optional)"
            hint="Paste a Pacsbin viewer URL to capture the slice/window/zoom for this finding."
          >
            {(p) => (
              <Input
                {...p}
                placeholder="https://pacsbin.com/viewer/case/<id>?state=…"
                value={viewerUrl}
                onChange={(e) => setViewerUrl(e.target.value)}
              />
            )}
          </Field>
        </div>

        {error && draft.label.trim() && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// Small local helper so we don't import IconButton just for the X.
function IconClose({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors",
        "hover:bg-danger/15 hover:text-danger",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        "[&_svg]:h-3.5 [&_svg]:w-3.5"
      )}
    >
      <CloseIcon />
    </button>
  );
}
