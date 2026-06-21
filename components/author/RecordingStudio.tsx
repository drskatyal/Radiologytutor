"use client";

// RecordingStudio — the full-page PACS recording surface (V1's core).
//
// A reading-room-dense layout: the multi-series Cornerstone viewer + the
// SeriesNavigator rail on the left, and a per-finding capture column on the
// right. The author scrolls / windows / pans and HOLDS Alt+X (or presses the
// Record button) to record a finding. WHILE RECORDING a recording-flow animation
// frames the ENTIRE viewer — a pulsing accent ring + glow and a REC chip with
// live elapsed time — so it is unmistakable that capture is live.
//
// On stop we:
//   1. transcribe + structure the narration (Gemini) → {label, description,
//      teachingPoints}; graceful no-key fallback to manual entry,
//   2. persist the narration audio (durable URL),
//   3. create a Finding with its `track` + `audioUrl`, anchored to the ACTIVE
//      series (so replay/student playback switch to the right series).
//
// Captured findings show as a list with replay (reuse lib/replay via the shared
// record/replay hook), re-record, edit and delete. Then the author publishes.
//
// This ELEVATES the existing RecordFindingDialog logic into a full surface; the
// /record demo is untouched.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Circle,
  Mic,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Spinner,
  Textarea,
  useToast,
} from "@/components/ui";
import { cn } from "@/components/ui/cn";
import {
  BUNDLED_CASE,
  BUNDLED_CASE_SERIES,
  caseSeriesToSource,
  type CaseSeries,
} from "@/lib/viewerSource";
import type { CaseData, Finding, RecordedTrack, StructuredFinding } from "@/lib/types";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { ReplayOverlayHandle } from "@/components/ReplayOverlay";
import { RecordStage } from "@/components/record/RecordStage";
import { useRecordReplay } from "@/components/record/useRecordReplay";
import {
  addFinding,
  deleteFinding,
  patchFinding,
  reorderFindings,
  structureFindingFromAudio,
  uploadAudio,
  LIMITS,
} from "@/components/author/lib";
import { updateCase } from "@/components/admin/api";

const EMPTY_DRAFT: StructuredFinding = { label: "", description: "", teachingPoints: [] };

type MicStatus = "unknown" | "granted" | "denied" | "unsupported";

export function RecordingStudio({
  initialCase,
  initialSeries,
}: {
  initialCase: CaseData;
  /** The case's series rail, resolved server-side. Empty → bundled sample. */
  initialSeries: CaseSeries[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [caseData, setCaseData] = useState<CaseData>(initialCase);
  const series = useMemo<CaseSeries[]>(
    () => (initialSeries.length > 0 ? initialSeries : BUNDLED_CASE_SERIES),
    [initialSeries]
  );
  const usingSample = initialSeries.length === 0;

  const controls = useRef<CornerstoneControls | null>(null);
  const overlay = useRef<ReplayOverlayHandle | null>(null);
  const [ready, setReady] = useState(false);
  const rr = useRecordReplay({ controls, overlay, ready });

  const [activeSeriesIndex, setActiveSeriesIndex] = useState(0);

  // Capture / structuring state for the IN-PROGRESS finding.
  const [draft, setDraft] = useState<StructuredFinding>(EMPTY_DRAFT);
  const [structuring, setStructuring] = useState(false);
  const [savingFinding, setSavingFinding] = useState(false);
  const [mic, setMic] = useState<MicStatus>("unknown");
  const [notice, setNotice] = useState("");

  // When re-recording an existing finding, the id we'll patch instead of create.
  const [editingFindingId, setEditingFindingId] = useState<string | null>(null);

  // Inline text-edit + delete dialogs for captured findings.
  const [editTarget, setEditTarget] = useState<Finding | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Finding | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [publishing, setPublishing] = useState(false);

  const findings = useMemo(
    () => [...caseData.findings].sort((a, b) => a.order - b.order),
    [caseData.findings]
  );

  const initialSource = useMemo(
    () => (series[0] ? caseSeriesToSource(series[0]) : BUNDLED_CASE),
    [series]
  );

  // Probe mic on mount so we can guide rather than fail silently.
  useEffect(() => {
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
  }, [rr.supported]);

  const onReady = useCallback((c: CornerstoneControls) => {
    controls.current = c;
    setReady(true);
  }, []);

  const hasTrack = !!rr.track && rr.track.events.length > 0;
  const recording = rr.phase === "recording";
  const micBlocked = mic === "denied" || mic === "unsupported";
  const canSaveDraft = !!draft.label.trim();

  // The active series UID — anchors the finding so playback opens on it.
  const activeSeries = series[activeSeriesIndex];

  async function beginRecording() {
    setNotice("");
    await rr.startRecording();
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    perms
      ?.query({ name: "microphone" as PermissionName })
      .then((s) =>
        setMic(s.state === "denied" ? "denied" : s.state === "granted" ? "granted" : mic)
      )
      .catch(() => {});
  }

  async function structureFromRecording() {
    if (!rr.audio) {
      toast({ variant: "warning", title: "Record some narration first" });
      return;
    }
    setStructuring(true);
    setNotice("");
    try {
      const result = await structureFindingFromAudio(rr.audio.base64, rr.audio.mimeType);
      if (result) {
        setDraft(result);
        setNotice("Structured from your narration — review and save.");
      } else {
        setNotice("AI structuring is off (no Gemini key). Type the finding in below.");
      }
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't structure narration",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setStructuring(false);
    }
  }

  /** Persist the captured finding (create new, or patch the one we re-recorded). */
  async function saveFinding() {
    if (!canSaveDraft || savingFinding) return;
    setSavingFinding(true);
    try {
      const base: Partial<Finding> = {
        label: draft.label.trim(),
        description: draft.description.trim(),
        teachingPoints: draft.teachingPoints.map((p) => p.trim()).filter(Boolean),
        state: " ",
        marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
      };

      if (hasTrack) {
        const track: RecordedTrack = { ...(rr.track as RecordedTrack) };
        if (rr.audio) {
          try {
            track.audioUrl = await uploadAudio(rr.audio.base64, rr.audio.mimeType);
          } catch {
            // Non-fatal: keep the silent retrace if upload fails.
          }
        }
        base.track = track;
        base.durationMs = track.durationMs;
      }

      // Anchor the finding to the active study/series (drives prefetch + the
      // student's series switch on playback).
      if (activeSeries && !usingSample) {
        base.seriesInstanceUID = activeSeries.seriesInstanceUID;
        base.studyInstanceUID = activeSeries.studyInstanceUID;
      }

      const updated =
        editingFindingId != null
          ? await patchFinding(caseData.caseId, editingFindingId, base)
          : await addFinding(caseData.caseId, base);
      setCaseData(updated);
      toast({
        variant: "success",
        title: editingFindingId ? "Finding re-recorded" : "Finding captured",
      });
      resetCapture();
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't save finding",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSavingFinding(false);
    }
  }

  function resetCapture() {
    rr.reset();
    setDraft(EMPTY_DRAFT);
    setEditingFindingId(null);
    setNotice("");
  }

  /** Replay an already-saved finding's track over the live viewer. */
  function replaySaved(f: Finding) {
    if (!f.track) return;
    rr.replay(f.track, f.track.audioUrl);
  }

  /** Start re-recording over an existing finding (keeps its text as the draft). */
  function reRecord(f: Finding) {
    rr.stopReplay();
    rr.reset();
    setEditingFindingId(f.id);
    setDraft({
      label: f.label,
      description: f.description,
      teachingPoints: [...f.teachingPoints],
    });
    setNotice("Re-recording — hold Alt+X to capture a new walk-through, then save.");
  }

  async function move(findingId: string, dir: -1 | 1) {
    const ids = findings.map((f) => f.id);
    const i = ids.indexOf(findingId);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const snapshot = caseData;
    const rank = new Map(ids.map((id, idx) => [id, idx + 1]));
    setCaseData({
      ...caseData,
      findings: caseData.findings
        .map((f) => ({ ...f, order: rank.get(f.id) ?? f.order }))
        .sort((a, b) => a.order - b.order),
    });
    try {
      const updated = await reorderFindings(caseData.caseId, ids);
      setCaseData(updated);
    } catch (e) {
      setCaseData(snapshot);
      toast({
        variant: "danger",
        title: "Couldn't reorder",
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const updated = await deleteFinding(caseData.caseId, deleteTarget.id);
      setCaseData(updated);
      setDeleteTarget(null);
      toast({ variant: "success", title: "Finding deleted" });
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't delete finding",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setDeleting(false);
    }
  }

  async function saveEdit(patch: Partial<Finding>) {
    if (!editTarget) return;
    const updated = await patchFinding(caseData.caseId, editTarget.id, patch);
    setCaseData(updated);
    setEditTarget(null);
    toast({ variant: "success", title: "Finding saved" });
  }

  async function publish() {
    if (publishing) return;
    setPublishing(true);
    try {
      const updated = await updateCase(caseData.caseId, { status: "published" });
      setCaseData((c) => ({ ...c, status: updated.status }));
      toast({
        variant: "success",
        title: "Case published",
        description: `"${updated.title}" is live for students.`,
      });
      router.push(`/case/${encodeURIComponent(caseData.caseId)}`);
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't publish",
        description: e instanceof Error ? e.message : undefined,
      });
      setPublishing(false);
    }
  }

  const published = caseData.status === "published";

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            Recording studio
            <Badge variant="accent" dot>
              {usingSample ? "Sample study" : "Live study"}
            </Badge>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-secondary">{caseData.title}</span>
            <Badge variant="neutral">{caseData.modality}</Badge>
            <Badge variant={published ? "success" : "warning"}>{caseData.status ?? "draft"}</Badge>
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted">
              {findings.length} finding{findings.length === 1 ? "" : "s"} captured
            </span>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<ArrowLeft className="h-4 w-4" />}
              onClick={() => router.push(`/author?case=${encodeURIComponent(caseData.caseId)}`)}
            >
              Editor
            </Button>
            <Button
              size="sm"
              leadingIcon={published ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
              onClick={publish}
              loading={publishing}
              disabled={published || findings.length === 0}
              title={
                findings.length === 0
                  ? "Capture at least one finding before publishing"
                  : undefined
              }
            >
              {published ? "Published" : "Review & publish"}
            </Button>
          </div>
        }
      />

      <div className="mx-auto grid max-w-[1500px] gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* ── Capture stage ─────────────────────────────────────────────── */}
        <div className="min-w-0">
          {/* The recording-flow frame: a pulsing glow + ring frames the WHOLE
              viewer while capture is live, so it's unmistakable that recording
              is on. Uses the design-system `mic-pulse` keyframe (token-driven). */}
          <div
            className={cn(
              "relative rounded-2xl border bg-imaging p-1 transition-colors duration-300",
              recording
                ? "animate-mic-pulse border-danger/70 ring-1 ring-danger/40"
                : "border-subtle"
            )}
          >
            <div className="overflow-hidden rounded-xl">
              <RecordStage
                source={initialSource}
                series={series}
                activeSeriesIndex={activeSeriesIndex}
                onSeriesChange={setActiveSeriesIndex}
                modality={caseData.modality}
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
          </div>

          {/* Transport controls */}
          <Card padded={false} className="mt-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              {recording ? (
                <Button
                  variant="danger"
                  leadingIcon={<Square className="h-4 w-4" />}
                  onClick={() => rr.stopRecording()}
                >
                  Stop recording
                </Button>
              ) : rr.phase === "replaying" ? (
                <Button
                  variant="secondary"
                  leadingIcon={<Square className="h-4 w-4" />}
                  onClick={rr.stopReplay}
                >
                  Stop replay
                </Button>
              ) : (
                <Button
                  leadingIcon={<Circle className="h-3.5 w-3.5 fill-current" />}
                  onClick={beginRecording}
                  disabled={!ready || mic === "unsupported"}
                >
                  {hasTrack ? "Re-record" : "Record finding"}
                </Button>
              )}

              <Button
                variant="secondary"
                leadingIcon={<Play className="h-4 w-4" />}
                onClick={() => rr.replay()}
                disabled={!hasTrack || rr.phase !== "idle"}
              >
                Replay
              </Button>
              <Button
                variant="ghost"
                leadingIcon={<Sparkles className="h-4 w-4" />}
                onClick={structureFromRecording}
                loading={structuring}
                disabled={!rr.audio || rr.phase !== "idle"}
              >
                Structure from voice
              </Button>

              {hasTrack && (
                <Badge variant={rr.audio ? "success" : "neutral"} className="ml-auto">
                  {(rr.track!.durationMs / 1000).toFixed(1)}s · {rr.track!.events.length} events
                  {rr.audio ? " · voice" : " · silent"}
                </Badge>
              )}
              {mic === "denied" && <Badge variant="warning">Mic blocked</Badge>}
              {mic === "unsupported" && <Badge variant="warning">Mic unavailable</Badge>}
            </div>

            {/* Hotkey hint */}
            {rr.phase === "idle" && !micBlocked && (
              <p className="mt-3 text-xs text-muted">
                Navigate the viewer and hold{" "}
                <kbd className="rounded border border-strong bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                  Alt
                </kbd>
                {" + "}
                <kbd className="rounded border border-strong bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                  X
                </kbd>{" "}
                to record while you narrate. The hotkey is ignored while you type.
              </p>
            )}
            {micBlocked && (
              <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-secondary">
                {mic === "unsupported"
                  ? "This browser can't record audio — you can still type each finding below and save it."
                  : "Microphone access is blocked. Allow it in your browser's address bar to narrate, or type the finding below."}
              </p>
            )}
          </Card>
        </div>

        {/* ── Capture column ────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Current-capture editor */}
          <Card padded={false} className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
                {editingFindingId ? (
                  <>
                    <RotateCcw className="h-4 w-4 text-accent" aria-hidden="true" />
                    Re-recording finding
                  </>
                ) : (
                  <>
                    <Mic className="h-4 w-4 text-accent" aria-hidden="true" />
                    Capture finding
                  </>
                )}
              </h2>
              {(hasTrack || draft.label || editingFindingId) && (
                <Button size="sm" variant="ghost" onClick={resetCapture}>
                  Clear
                </Button>
              )}
            </div>

            {notice && (
              <p className="mb-3 rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-secondary">
                {notice}
              </p>
            )}

            <div className="flex flex-col gap-3">
              <Field label="Label" required>
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

              <TeachingPoints
                points={draft.teachingPoints}
                onChange={(teachingPoints) => setDraft((d) => ({ ...d, teachingPoints }))}
              />

              {structuring && (
                <div className="flex items-center gap-2.5 rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-secondary">
                  <Spinner size="sm" />
                  Structuring from your narration…
                </div>
              )}

              <Button
                onClick={saveFinding}
                loading={savingFinding}
                disabled={!canSaveDraft}
                leadingIcon={<Plus className="h-4 w-4" />}
              >
                {editingFindingId ? "Save re-recording" : "Add to teaching sequence"}
              </Button>
              {!canSaveDraft && (
                <p className="text-center text-[11px] text-muted">
                  Record a walk-through and give the finding a label to save it.
                </p>
              )}
            </div>
          </Card>

          {/* Captured findings */}
          <Card padded={false} className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
                Teaching sequence
                <span className="rounded-full bg-elevated px-2 py-0.5 text-xs tabular-nums text-muted">
                  {findings.length}
                </span>
              </h2>
            </div>

            {findings.length === 0 ? (
              <EmptyState
                title="No findings captured yet"
                description="Hold Alt+X over the viewer to record your first narrated finding."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {findings.map((f, i) => (
                  <CapturedFindingRow
                    key={f.id}
                    finding={f}
                    index={i}
                    total={findings.length}
                    busy={rr.phase !== "idle"}
                    onReplay={() => replaySaved(f)}
                    onReRecord={() => reRecord(f)}
                    onEdit={() => setEditTarget(f)}
                    onDelete={() => setDeleteTarget(f)}
                    onMove={(dir) => move(f.id, dir)}
                  />
                ))}
              </ul>
            )}
          </Card>

          {/* Review & publish summary */}
          <Card padded={false} className="p-4">
            <h2 className="text-sm font-semibold text-primary">Review &amp; publish</h2>
            <p className="mt-1 text-xs text-muted">
              Cases stay hidden from students until you publish. You can keep editing text and
              order in the case editor afterwards.
            </p>
            <Button
              className="mt-3 w-full"
              leadingIcon={published ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
              onClick={publish}
              loading={publishing}
              disabled={published || findings.length === 0}
            >
              {published ? "Published" : "Publish case"}
            </Button>
          </Card>
        </div>
      </div>

      {/* Edit-text dialog */}
      <EditFindingDialog
        finding={editTarget}
        onClose={() => setEditTarget(null)}
        onSave={saveEdit}
      />

      {/* Delete confirm */}
      <Modal
        open={!!deleteTarget}
        onClose={() => !deleting && setDeleteTarget(null)}
        title="Delete this finding?"
        description="This removes the finding and its recording from the teaching sequence."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={deleting}>
              Delete finding
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <p>
            <span className="font-medium text-primary">{deleteTarget.label}</span>
            {deleteTarget.description ? ` — ${deleteTarget.description}` : ""}
          </p>
        )}
      </Modal>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────

function CapturedFindingRow({
  finding,
  index,
  total,
  busy,
  onReplay,
  onReRecord,
  onEdit,
  onDelete,
  onMove,
}: {
  finding: Finding;
  index: number;
  total: number;
  busy: boolean;
  onReplay: () => void;
  onReRecord: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const hasTrack = !!finding.track && (finding.track.events?.length ?? 0) > 0;
  const dur = finding.track ? (finding.track.durationMs / 1000).toFixed(1) : null;
  const voiced = !!finding.track?.audioUrl;

  return (
    <li className="rounded-xl border border-subtle bg-surface p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-xs font-semibold tabular-nums text-accent">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-primary">
            {finding.label || "Untitled finding"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {hasTrack ? (
              <Badge variant={voiced ? "success" : "neutral"}>
                {dur}s {voiced ? "· voice" : "· silent"}
              </Badge>
            ) : (
              <Badge variant="warning">No recording</Badge>
            )}
            {finding.teachingPoints.length > 0 && (
              <Badge variant="neutral">
                {finding.teachingPoints.length} point
                {finding.teachingPoints.length === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <IconButton
            size="sm"
            aria-label="Move finding up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ChevronUp />
          </IconButton>
          <IconButton
            size="sm"
            aria-label="Move finding down"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <ChevronDown />
          </IconButton>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<Play className="h-3.5 w-3.5" />}
          onClick={onReplay}
          disabled={!hasTrack || busy}
        >
          Replay
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<RotateCcw className="h-3.5 w-3.5" />}
          onClick={onReRecord}
          disabled={busy}
        >
          Re-record
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<Pencil className="h-3.5 w-3.5" />}
          onClick={onEdit}
        >
          Edit
        </Button>
        <span className="flex-1" />
        <IconButton size="sm" variant="danger" aria-label="Delete finding" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>
    </li>
  );
}

function TeachingPoints({
  points,
  onChange,
}: {
  points: string[];
  onChange: (points: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-secondary">Teaching points</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={points.length >= LIMITS.teachingPoints}
          onClick={() => onChange([...points, ""])}
        >
          Add point
        </Button>
      </div>
      {points.length === 0 ? (
        <p className="rounded-lg border border-dashed border-strong px-3 py-2 text-xs text-muted">
          No teaching points yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {points.map((pt, i) => (
            <li key={i} className="flex items-center gap-2">
              <Input
                className="h-9 text-sm"
                placeholder="Teaching point…"
                aria-label={`Teaching point ${i + 1}`}
                value={pt}
                maxLength={LIMITS.teachingPoint}
                onChange={(e) =>
                  onChange(points.map((p, idx) => (idx === i ? e.target.value : p)))
                }
              />
              <IconButton
                size="sm"
                variant="danger"
                aria-label={`Remove teaching point ${i + 1}`}
                onClick={() => onChange(points.filter((_, idx) => idx !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EditFindingDialog({
  finding,
  onClose,
  onSave,
}: {
  finding: Finding | null;
  onClose: () => void;
  onSave: (patch: Partial<Finding>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<StructuredFinding>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (finding) {
      setDraft({
        label: finding.label,
        description: finding.description,
        teachingPoints: [...finding.teachingPoints],
      });
    }
  }, [finding]);

  async function commit() {
    if (!draft.label.trim() || saving) return;
    setSaving(true);
    try {
      await onSave({
        label: draft.label.trim(),
        description: draft.description.trim(),
        teachingPoints: draft.teachingPoints.map((p) => p.trim()).filter(Boolean),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!finding}
      onClose={() => !saving && onClose()}
      title="Edit finding text"
      description="Refine the structured output. The recording is kept."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={commit} loading={saving} disabled={!draft.label.trim()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Label" required>
          {(p) => (
            <Input
              {...p}
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
              value={draft.description}
              maxLength={LIMITS.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
          )}
        </Field>
        <TeachingPoints
          points={draft.teachingPoints}
          onChange={(teachingPoints) => setDraft((d) => ({ ...d, teachingPoints }))}
        />
      </div>
    </Modal>
  );
}

function ChevronUp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <path d="m18 15-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
