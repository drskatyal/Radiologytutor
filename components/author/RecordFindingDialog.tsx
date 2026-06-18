"use client";

// Record a finding: the teacher navigates the viewer and HOLDS Alt+X (or the
// record button) to capture a narrated walk-through — the ordered viewer event
// log + their voice on one clock. On release they can REPLAY the exact retrace
// (with the laser-pointer overlay) to check it, then SAVE:
//
//   1. upload the narration audio   → POST /api/audio  (durable URL)
//   2. structure it (Gemini STT + structuring) if a key is configured — else a
//      graceful no-op and the author fills the text in by hand
//   3. create the finding via lib/cases with its `track` + `audioUrl` + text
//
// The created finding is then fully editable in the existing Author UI.
//
// The recording surface uses the bundled sample image (the viewer source is a
// swappable seam); the captured track replays identically wherever it's shown.

import { useRef, useState } from "react";
import {
  Button,
  Badge,
  Field,
  Input,
  Textarea,
  Modal,
  Spinner,
} from "@/components/ui";
import { BUNDLED_CASE } from "@/lib/viewerSource";
import type { Finding, RecordedTrack, StructuredFinding } from "@/lib/types";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ReplayOverlayHandle } from "@/components/ReplayOverlay";
import { RecordStage } from "@/components/record/RecordStage";
import { useRecordReplay } from "@/components/record/useRecordReplay";
import { structureFindingFromAudio, uploadAudio } from "./lib";

interface RecordFindingDialogProps {
  open: boolean;
  onClose: () => void;
  /** Append the finding; resolves when created (parent toasts/refreshes). */
  onCreate: (finding: Partial<Finding>) => Promise<void>;
}

const EMPTY: StructuredFinding = { label: "", description: "", teachingPoints: [] };

export function RecordFindingDialog({ open, onClose, onCreate }: RecordFindingDialogProps) {
  const controls = useRef<CornerstoneControls | null>(null);
  const overlay = useRef<ReplayOverlayHandle | null>(null);
  const [ready, setReady] = useState(false);
  const rr = useRecordReplay({ controls, overlay, ready });

  const [draft, setDraft] = useState<StructuredFinding>(EMPTY);
  const [structuring, setStructuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Remount the stage per open so the viewer/recorder reset cleanly.
  if (!open) return null;

  const hasTrack = !!rr.track && rr.track.events.length > 0;

  const onReady = (c: CornerstoneControls) => {
    controls.current = c;
    setReady(true);
  };

  async function structureFromRecording() {
    if (!rr.audio) {
      setError("Record some narration first, then structure it.");
      return;
    }
    setStructuring(true);
    setError("");
    setNotice("");
    try {
      const result = await structureFindingFromAudio(rr.audio.base64, rr.audio.mimeType);
      if (result) {
        setDraft(result);
        setNotice("Structured from your narration — review below.");
      } else {
        setNotice("AI structuring is off (no Gemini key). Fill the fields in by hand.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to structure");
    } finally {
      setStructuring(false);
    }
  }

  async function save() {
    if (!hasTrack) {
      setError("Record a walk-through first (hold Alt+X).");
      return;
    }
    if (!draft.label.trim()) {
      setError("A label is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const track: RecordedTrack = { ...(rr.track as RecordedTrack) };
      // Persist the narration audio (if any) and attach its durable URL.
      if (rr.audio) {
        try {
          track.audioUrl = await uploadAudio(rr.audio.base64, rr.audio.mimeType);
        } catch {
          // Non-fatal: keep the silent retrace if the upload fails.
        }
      }
      await onCreate({
        label: draft.label.trim(),
        description: draft.description.trim(),
        teachingPoints: draft.teachingPoints.map((p) => p.trim()).filter(Boolean),
        // A finding needs a state + marker to be valid; the recorded track is
        // the real flow, so a placeholder state + centre marker suffice.
        state: " ",
        marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
        track,
        durationMs: track.durationMs,
      });
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create finding");
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    rr.stopReplay();
    setDraft(EMPTY);
    setError("");
    setNotice("");
    setReady(false);
    onClose();
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
      onClose={handleClose}
      size="xl"
      title="Record a finding"
      description="Navigate the viewer and hold Alt+X to record a narrated walk-through. Replay to check it, then save."
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!hasTrack || !draft.label.trim()}>
            Save finding
          </Button>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        {/* Capture stage */}
        <div className="overflow-hidden rounded-xl border border-subtle">
          <RecordStage
            source={BUNDLED_CASE}
            controls={controls}
            overlay={overlay}
            ready={ready}
            phase={rr.phase}
            elapsedMs={rr.elapsedMs}
            progress={rr.progress}
            onReady={onReady}
            onEvent={rr.onViewerEvent}
            onCursor={rr.onCursor}
          />
        </div>

        {/* Record / replay controls */}
        <div className="flex flex-wrap items-center gap-2">
          {rr.phase === "recording" ? (
            <Button variant="danger" size="sm" onClick={() => rr.stopRecording()}>
              Stop recording
            </Button>
          ) : rr.phase === "replaying" ? (
            <Button variant="secondary" size="sm" onClick={rr.stopReplay}>
              Stop replay
            </Button>
          ) : (
            <Button size="sm" onClick={() => rr.startRecording()} disabled={!ready}>
              {hasTrack ? "Re-record" : "Record"}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => rr.replay()}
            disabled={!hasTrack || rr.phase !== "idle"}
          >
            Replay
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={structureFromRecording}
            loading={structuring}
            disabled={!rr.audio || rr.phase !== "idle"}
          >
            Structure from narration
          </Button>
          {hasTrack && (
            <Badge variant="success">
              {(rr.track!.durationMs / 1000).toFixed(1)}s · {rr.track!.events.length} events
              {rr.audio ? " · voice" : " · silent"}
            </Badge>
          )}
          {!rr.supported && <Badge variant="warning">Mic unavailable</Badge>}
        </div>

        {notice && (
          <p className="rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-secondary">
            {notice}
          </p>
        )}

        {/* Structured text (editable) */}
        <div className="space-y-3">
          <Field label="Label" required error={error && !draft.label.trim() ? error : undefined}>
            {(p) => (
              <Input
                {...p}
                placeholder="Short finding name (e.g. ACL tear)"
                value={draft.label}
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
                      onChange={(e) => setPoint(i, e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={`Remove teaching point ${i + 1}`}
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          teachingPoints: d.teachingPoints.filter((_, idx) => idx !== i),
                        }))
                      }
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-danger/15 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                    >
                      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5">
                        <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {structuring && (
          <div className="flex items-center gap-3 rounded-xl border border-subtle bg-surface px-4 py-3 text-sm text-secondary">
            <Spinner size="sm" />
            Structuring from your narration…
          </div>
        )}

        {error && draft.label.trim() && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
