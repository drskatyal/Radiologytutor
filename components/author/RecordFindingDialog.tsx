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

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  Button,
  Badge,
  Field,
  Input,
  Textarea,
  Modal,
  Spinner,
} from "@/components/ui";
import {
  BUNDLED_CASE,
  BUNDLED_CASE_SERIES,
  caseSeriesToSource,
  type CaseSeries,
} from "@/lib/viewerSource";
import type { Finding, RecordedTrack, StructuredFinding } from "@/lib/types";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ReplayOverlayHandle } from "@/components/ReplayOverlay";
import { RecordStage } from "@/components/record/RecordStage";
import { useRecordReplay } from "@/components/record/useRecordReplay";
import { LIMITS, markerFromTrack, structureFindingFromAudio, uploadAudio, validateDraft } from "./lib";

interface RecordFindingDialogProps {
  open: boolean;
  onClose: () => void;
  /** The case being authored — used to resolve its series rail for capture. */
  caseId?: string;
  /** Append the finding; resolves when created (parent toasts/refreshes). */
  onCreate: (finding: Partial<Finding>) => Promise<void>;
}

const EMPTY: StructuredFinding = { label: "", description: "", teachingPoints: [] };

/** Mic availability, so we can guide the author instead of failing silently. */
type MicStatus = "unknown" | "granted" | "denied" | "unsupported";

export function RecordFindingDialog({ open, onClose, caseId, onCreate }: RecordFindingDialogProps) {
  const controls = useRef<CornerstoneControls | null>(null);
  const overlay = useRef<ReplayOverlayHandle | null>(null);
  const [ready, setReady] = useState(false);
  const rr = useRecordReplay({ controls, overlay, ready });

  const [draft, setDraft] = useState<StructuredFinding>(EMPTY);
  const [structuring, setStructuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mic, setMic] = useState<MicStatus>("unknown");

  // The case's series rail. Resolved from /api/cases/[caseId]/series on open;
  // falls back to the bundled single-series sample when imaging isn't resolved
  // (no Orthanc / no caseId). The author records against the SAME navigator the
  // student sees, and the captured track replays identically wherever shown.
  const [series, setSeries] = useState<CaseSeries[]>(BUNDLED_CASE_SERIES);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [activeSeriesIndex, setActiveSeriesIndex] = useState(0);

  useEffect(() => {
    if (!open || !caseId) {
      setSeries(BUNDLED_CASE_SERIES);
      setActiveSeriesIndex(0);
      return;
    }
    let alive = true;
    setSeriesLoading(true);
    fetch(`/api/cases/${encodeURIComponent(caseId)}/series`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { series?: CaseSeries[]; hasImaging?: boolean } | null) => {
        if (!alive) return;
        const resolved = data?.series ?? [];
        setSeries(resolved.length > 0 ? resolved : BUNDLED_CASE_SERIES);
        setActiveSeriesIndex(0);
      })
      .catch(() => {
        if (alive) setSeries(BUNDLED_CASE_SERIES);
      })
      .finally(() => {
        if (alive) setSeriesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, caseId]);

  // The viewer initializes from the FIRST series; later switches flow through
  // `series`/`activeSeriesIndex` (no remount). Memoize so the source identity is
  // stable across renders (the viewer re-inits only when the rail itself changes).
  const initialSource = useMemo(
    () => (series[0] ? caseSeriesToSource(series[0]) : BUNDLED_CASE),
    [series]
  );

  // Probe mic availability when the dialog opens so we can guide up front,
  // never fail silently. The Permissions API isn't everywhere; fall back to
  // "unknown" (we'll learn the real answer when they hit record).
  useEffect(() => {
    if (!open) return;
    if (!rr.supported) {
      setMic("unsupported");
      return;
    }
    let alive = true;
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    perms
      ?.query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (!alive) return;
        setMic(
          status.state === "granted"
            ? "granted"
            : status.state === "denied"
              ? "denied"
              : "unknown"
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, rr.supported]);

  // Remount the stage per open so the viewer/recorder reset cleanly.
  if (!open) return null;

  const hasTrack = !!rr.track && rr.track.events.length > 0;
  const errors = validateDraft(draft);
  const canSave = !!draft.label.trim() && !errors.label;
  const micBlocked = mic === "denied" || mic === "unsupported";

  const onReady = (c: CornerstoneControls) => {
    controls.current = c;
    setReady(true);
  };

  async function beginRecording() {
    setError("");
    await rr.startRecording();
    // If a track is in progress now, the mic prompt was accepted (or skipped).
    // We can't read the recorder's grant directly, so reconcile via Permissions.
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    perms
      ?.query({ name: "microphone" as PermissionName })
      .then((s) => setMic(s.state === "denied" ? "denied" : s.state === "granted" ? "granted" : mic))
      .catch(() => {});
  }

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
    // Label is the only hard requirement — a recording is encouraged but never
    // mandatory (mic blocked / nothing captured must still let them save text).
    if (!draft.label.trim()) {
      setError("Give the finding a short label, then save.");
      return;
    }
    if (errors.label) {
      setError(errors.label);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const trackMarker = hasTrack ? markerFromTrack(rr.track as RecordedTrack) : null;
      const base: Partial<Finding> = {
        label: draft.label.trim(),
        description: draft.description.trim(),
        teachingPoints: draft.teachingPoints.map((p) => p.trim()).filter(Boolean),
        // A finding needs a state + marker to be valid. Prefer last cursor from
        // the walk-through; otherwise a centre placeholder (author can refine).
        state: " ",
        marker: trackMarker ?? { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
      };

      if (hasTrack) {
        const track: RecordedTrack = { ...(rr.track as RecordedTrack) };
        // Persist the narration audio (if any) and attach its durable URL.
        if (rr.audio) {
          try {
            track.audioUrl = await uploadAudio(rr.audio.base64, rr.audio.mimeType);
          } catch {
            // Non-fatal: keep the silent retrace if the upload fails — the
            // recording is never lost, just narrated silently.
          }
        }
        base.track = track;
        base.durationMs = track.durationMs;
      }

      const active = series[activeSeriesIndex];
      if (active && active.seriesInstanceUID !== BUNDLED_CASE_SERIES[0]?.seriesInstanceUID) {
        base.seriesInstanceUID = active.seriesInstanceUID;
        base.studyInstanceUID = active.studyInstanceUID;
      }

      await onCreate(base);
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
          <Button onClick={save} loading={saving} disabled={!canSave}>
            Save finding
          </Button>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        {/* Mic blocked / unsupported — never a dead end: explain the manual path. */}
        {micBlocked && (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-secondary">
            <p className="font-medium text-warning">
              {mic === "unsupported"
                ? "This browser can't record audio"
                : "Microphone access is blocked"}
            </p>
            <p className="mt-1 leading-relaxed">
              {mic === "unsupported"
                ? "You can still build this finding — type the label, description and teaching points below and save."
                : "Allow the microphone in your browser's address-bar settings to narrate, or just type the finding below and save without narration."}
            </p>
          </div>
        )}

        {/* Capture stage — viewer + the same series rail the student sees. The
            `source` is the FIRST series only (a stable seam); subsequent series
            changes flow through `series`/`activeSeriesIndex` (no remount). */}
        <div className="overflow-hidden rounded-xl border border-subtle">
          <RecordStage
            source={initialSource}
            series={series}
            activeSeriesIndex={activeSeriesIndex}
            onSeriesChange={setActiveSeriesIndex}
            seriesLoading={seriesLoading}
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
            <Button
              size="sm"
              onClick={beginRecording}
              disabled={!ready || mic === "unsupported"}
            >
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
            title={
              !rr.audio
                ? "Record some narration first to structure it with AI"
                : undefined
            }
          >
            Structure from narration
          </Button>
          {hasTrack && (
            <Badge variant={rr.audio ? "success" : "neutral"}>
              {(rr.track!.durationMs / 1000).toFixed(1)}s · {rr.track!.events.length} events
              {rr.audio ? " · voice" : " · silent"}
            </Badge>
          )}
          {mic === "unsupported" && <Badge variant="warning">Mic unavailable</Badge>}
          {mic === "denied" && <Badge variant="warning">Mic blocked</Badge>}
        </div>

        {/* Hotkey + silent-track hints. */}
        {rr.phase === "idle" && !micBlocked && (
          <p className="text-xs text-muted">
            Tip: navigate the viewer and hold{" "}
            <kbd className="rounded border border-strong bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-secondary">
              Alt
            </kbd>
            {" + "}
            <kbd className="rounded border border-strong bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-secondary">
              X
            </kbd>{" "}
            to record while you talk. The hotkey is ignored while you type.
          </p>
        )}
        {hasTrack && !rr.audio && rr.phase === "idle" && (
          <p className="rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-secondary">
            Captured a silent walk-through (no narration recorded). You can re-record
            with audio, or save it as-is and type the teaching text below.
          </p>
        )}

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
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
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
