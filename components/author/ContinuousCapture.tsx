"use client";

// ContinuousCapture — harness demonstration UI ("speak once" authoring).
//
// The radiologist scrolls/windows/clicks while holding one take. We record the
// viewer event log, and the microphone when it opens, on one clock. On stop,
// Gemini segments a real dictation into structured findings; mergeCaptureDemonstration
// aligns each segment to the DICOM track. With no microphone the same stop still
// keeps the viewer track, and Save builds narration spans plus a notes-voiced
// teaching guide from that track and the typed label, description, and points.

import { useState } from "react";
import { Check, Layers, Mic, Sparkles, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  MicButton,
  Spinner,
  Textarea,
  useToast,
  type MicState,
} from "@/components/ui";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { Finding, RecordedTrack, StructuredSessionFinding } from "@/lib/types";
import { RecordedTakeNote } from "@/components/author/RecordedTakeNote";
import {
  AiUnavailableError,
  LIMITS,
  markerFromTrack,
  structureSession,
  uploadAudio,
  addFinding,
  saveCaptureSession,
} from "@/components/author/lib";
import { mergeCaptureDemonstration } from "@/lib/harness/mergeCapture";
import { displaySliceNumber, withDisplaySnapshot } from "@/lib/findingDisplayState";
import {
  commitSpeakOnceWithoutMic,
  formatRecordedSave,
  settledDisplay,
} from "@/lib/teachingGuide";
import type { useRecordReplay } from "@/components/record/useRecordReplay";
import type { MutableRefObject } from "react";

type RR = ReturnType<typeof useRecordReplay>;

export function ContinuousCapture({
  caseId,
  rr,
  controls,
  seriesInstanceUID,
  studyInstanceUID,
  onCaseUpdated,
}: {
  caseId: string;
  rr: RR;
  controls: MutableRefObject<CornerstoneControls | null>;
  seriesInstanceUID?: string;
  studyInstanceUID?: string;
  onCaseUpdated: (c: Awaited<ReturnType<typeof addFinding>>) => void;
}) {
  const { toast } = useToast();
  const [micState, setMicState] = useState<MicState>("idle");
  const [structuring, setStructuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [proposals, setProposals] = useState<StructuredSessionFinding[]>([]);
  const [notice, setNotice] = useState("");
  const [lastTake, setLastTake] = useState<{
    track: RecordedTrack;
    audio: { base64: string; mimeType: string } | null;
  } | null>(null);

  const recording = rr.phase === "recording";
  const notesMode = Boolean(lastTake && !lastTake.audio && proposals.length > 0 && !recording);

  async function start() {
    setNotice("");
    setProposals([]);
    setTranscript("");
    setLastTake(null);
    try {
      const started = await rr.startRecording();
      if (!started) {
        setMicState("idle");
        setNotice("The viewer isn't ready yet — wait for the study, then start again.");
        return;
      }
      setMicState("recording");
    } catch {
      toast({
        variant: "warning",
        title: "Couldn't start capture",
        description: "The viewer track didn't start. Try again once the study is open.",
      });
      setMicState("idle");
    }
  }

  function openNotesDraft(track: RecordedTrack) {
    const marker =
      markerFromTrack(track) ?? { x_pct: 0.5, y_pct: 0.5, shape: "circle" as const };
    setProposals([
      {
        label: "",
        description: "",
        teachingPoints: [],
        tStartMs: 0,
        tEndMs: Math.max(track.durationMs, 1),
        suggestedMarker: marker,
        suggestedSliceIndex: settledDisplay(track).sliceIndex,
      },
    ]);
    setNotice("");
  }

  async function stop() {
    setMicState("processing");
    const captured = await rr.stopRecording();
    if (!captured?.track) {
      setMicState("idle");
      setNotice("Nothing captured — scroll the study, then stop.");
      return;
    }
    const { track, audio } = captured;
    setLastTake({ track, audio });
    if (!audio) {
      openNotesDraft(track);
      setMicState("idle");
      return;
    }
    setStructuring(true);
    try {
      const result = await structureSession({
        audioBase64: audio.base64,
        audioMime: audio.mimeType,
        durationMs: track.durationMs,
        track,
      });
      if (!result) {
        setNotice(
          "AI structuring is off (no Gemini key). You can still save a single walk-through from the panel below."
        );
        setMicState("idle");
        return;
      }
      setTranscript(result.transcript);
      setProposals(result.findings);
      setNotice(
        result.findings.length
          ? `Segmented into ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} — review fields, then save all.`
          : "No findings detected in the dictation — try speaking lesion names and signs clearly."
      );
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        setNotice(e.message);
      } else {
        toast({
          variant: "danger",
          title: "Couldn't structure session",
          description: e instanceof Error ? e.message : undefined,
        });
      }
    } finally {
      setStructuring(false);
      setMicState("idle");
    }
  }

  function patchProposal(i: number, patch: Partial<StructuredSessionFinding>) {
    setProposals((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  function removeProposal(i: number) {
    setProposals((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function saveNotes(parentTrack: RecordedTrack) {
    const draft = proposals.find((p) => p.label.trim());
    if (!draft) return;
    setSaving(true);
    try {
      const marker =
        draft.suggestedMarker ??
        markerFromTrack(parentTrack) ?? { x_pct: 0.5, y_pct: 0.5, shape: "circle" as const };
      const { finding, receipt } = commitSpeakOnceWithoutMic<Partial<Finding>>(
        {
          label: draft.label.trim(),
          description: draft.description.trim(),
          teachingPoints: draft.teachingPoints.map((point) => point.trim()).filter(Boolean),
          marker,
          state: " ",
          studyInstanceUID,
          seriesInstanceUID: seriesInstanceUID || controls.current?.activeSeriesUID,
        },
        parentTrack
      );
      const live = controls.current?.getStartState();
      const money = settledDisplay(finding.track ?? parentTrack);
      const seriesUID =
        finding.seriesInstanceUID || seriesInstanceUID || controls.current?.activeSeriesUID;
      const sessionId = `cap_${Date.now().toString(36)}`;
      const snap = {
        sliceIndex: money.sliceIndex,
        ww: money.ww,
        wc: money.wc,
        sopInstanceUID:
          money.sliceIndex === live?.sliceIndex ? live?.sopInstanceUID : undefined,
      };
      const stored = withDisplaySnapshot(
        {
          ...finding,
          state: finding.state || " ",
          marker,
          seriesInstanceUID: seriesUID,
          studyInstanceUID,
          anchors: [
            withDisplaySnapshot(
              {
                studyInstanceUID,
                seriesInstanceUID: seriesUID,
                marker,
                viewportRole: "primary" as const,
                studyRole: "current" as const,
              },
              snap
            ),
          ],
          captureSessionId: sessionId,
          tStartMs: 0,
          tEndMs: Math.max(finding.durationMs ?? parentTrack.durationMs, 1),
        },
        snap
      );
      let updated = await addFinding(caseId, stored);
      const narration = (finding.track?.narration ?? []).map((span) => span.text).join(" ");
      updated = await saveCaptureSession(caseId, {
        id: sessionId,
        durationMs: finding.track?.durationMs ?? parentTrack.durationMs,
        track: finding.track ?? parentTrack,
        ...(narration ? { transcript: narration } : {}),
        createdAt: new Date().toISOString(),
      });
      onCaseUpdated(updated);
      const message = formatRecordedSave(receipt);
      toast({
        variant: message.tone === "degraded" ? "warning" : "success",
        title: message.title,
        description: message.description,
        duration: 7000,
      });
      setProposals([]);
      setTranscript("");
      setLastTake(null);
      setNotice("");
      rr.reset();
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't save findings",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  async function saveAll() {
    if (!proposals.length || saving) return;
    const parentTrack = lastTake?.track ?? (rr.track as RecordedTrack | null);
    if (!parentTrack) {
      toast({ variant: "warning", title: "No recorded track to attach" });
      return;
    }
    if (notesMode) {
      await saveNotes(parentTrack);
      return;
    }
    const takeAudio = lastTake?.audio ?? rr.audio;
    setSaving(true);
    try {
      let audioUrl: string | undefined;
      if (takeAudio) {
        try {
          audioUrl = await uploadAudio(takeAudio.base64, takeAudio.mimeType);
        } catch {
          /* keep silent segments */
        }
      }
      const sessionId = `cap_${Date.now().toString(36)}`;
      const live = controls.current?.getStartState();
      const seriesUID =
        seriesInstanceUID || controls.current?.activeSeriesUID || undefined;

      const { session, findings } = mergeCaptureDemonstration({
        sessionId,
        parentTrack,
        segments: proposals,
        transcript,
        audioUrl,
        studyInstanceUID,
        seriesInstanceUID: seriesUID,
        sopInstanceUID: live?.sopInstanceUID,
      });

      let updated = null as Awaited<ReturnType<typeof addFinding>> | null;
      for (const draft of findings) {
        const snap = {
          sliceIndex: draft.sliceIndex ?? live?.sliceIndex ?? 0,
          ww: draft.windowWidth ?? live?.ww,
          wc: draft.windowCenter ?? live?.wc,
          sopInstanceUID: draft.sopInstanceUID ?? live?.sopInstanceUID,
        };
        const finding = withDisplaySnapshot(
          {
            ...draft,
            state: draft.state || " ",
            marker: draft.marker!,
          } as Partial<Finding>,
          snap
        );
        updated = await addFinding(caseId, finding);
      }

      if (updated) {
        updated = await saveCaptureSession(caseId, session);
        onCaseUpdated(updated);
        toast({
          variant: "success",
          title: "Findings saved",
          description: `${findings.length} finding${findings.length === 1 ? "" : "s"} from one take — demonstration stored.`,
        });
        setProposals([]);
        setTranscript("");
        setLastTake(null);
        rr.reset();
      }
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't save findings",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  function guideFor(p: StructuredSessionFinding) {
    if (notesMode && lastTake) {
      return commitSpeakOnceWithoutMic<Partial<Finding>>(
        {
          label: p.label,
          description: p.description,
          teachingPoints: p.teachingPoints,
          marker: p.suggestedMarker,
        },
        lastTake.track
      ).finding.teachingGuide;
    }
    return p.teachingGuide;
  }

  return (
    <Card padded={false} className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Layers className="h-4 w-4 text-accent" aria-hidden="true" />
          Speak once — structure many
        </h2>
        <div className="flex items-center gap-1.5">
          {recording && (
            <Badge variant="danger" dot>
              Capturing
            </Badge>
          )}
          {(recording && rr.micCapture === "unavailable") || notesMode ? (
            <Badge variant="warning">No microphone</Badge>
          ) : null}
        </div>
      </div>

      <p className="mb-3 text-xs leading-relaxed text-muted">
        Scroll the study and narrate every finding in one take. We timestamp the
        viewer and your voice, then merge them into the teaching script. Without
        a microphone the viewer track still records, and Save teaches from the
        notes you type.
      </p>

      <div className="rounded-xl border border-subtle bg-surface/80 px-3 py-3">
        <MicButton
          state={structuring ? "processing" : micState}
          onStart={start}
          onStop={stop}
          disabled={structuring || saving || rr.phase === "replaying"}
          label={
            recording
              ? rr.micCapture === "live"
                ? "Capturing — keep scrolling & speaking…"
                : rr.micCapture === "unavailable"
                  ? "Capturing the viewer — no microphone"
                  : "Capturing the viewer…"
              : structuring
                ? "Structuring session…"
                : "Start continuous capture"
          }
        />
      </div>

      {notice && (
        <p className="mt-3 rounded-lg border border-subtle bg-canvas/40 px-3 py-2 text-xs text-secondary">
          {notice}
        </p>
      )}

      {structuring && (
        <div className="mt-3 flex items-center gap-2 text-xs text-secondary">
          <Spinner size="sm" />
          Transcribing &amp; segmenting findings…
        </div>
      )}

      {notesMode && lastTake && (
        <div className="mt-3">
          <RecordedTakeNote
            track={lastTake.track}
            hasAudio={false}
            point={
              proposals[0]?.suggestedMarker
                ? {
                    x: proposals[0].suggestedMarker.x_pct,
                    y: proposals[0].suggestedMarker.y_pct,
                  }
                : undefined
            }
          />
        </div>
      )}

      {transcript && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Full transcript
          </p>
          <p className="max-h-24 overflow-y-auto rounded-lg border border-subtle bg-canvas/50 px-2.5 py-2 text-xs italic text-secondary">
            {transcript}
          </p>
        </div>
      )}

      {proposals.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {proposals.map((p, i) => {
            const guide = guideFor(p);
            return (
            <li
              key={`${p.tStartMs}-${i}`}
              className="rounded-xl border border-subtle bg-elevated/40 p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <Badge variant="accent">
                  {(p.tStartMs / 1000).toFixed(1)}s – {(p.tEndMs / 1000).toFixed(1)}s
                </Badge>
                <div className="flex items-center gap-1">
                  {guide && guide.beats.length > 0 && (
                    <Badge variant="neutral">
                      {guide.beats.length} teach {guide.beats.length === 1 ? "beat" : "beats"}
                    </Badge>
                  )}
                  {p.suggestedMarker && (
                    <Badge variant="neutral">
                      mark {(p.suggestedMarker.x_pct * 100).toFixed(0)}%,
                      {(p.suggestedMarker.y_pct * 100).toFixed(0)}%
                      {p.suggestedSliceIndex != null
                        ? ` · slice ${displaySliceNumber(p.suggestedSliceIndex)}`
                        : ""}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove proposal ${i + 1}`}
                    onClick={() => removeProposal(i)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Field label="Label" required>
                  {(props) => (
                    <Input
                      {...props}
                      value={p.label}
                      maxLength={LIMITS.label}
                      onChange={(e) => patchProposal(i, { label: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Description">
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={2}
                      value={p.description}
                      maxLength={LIMITS.description}
                      onChange={(e) =>
                        patchProposal(i, { description: e.target.value })
                      }
                    />
                  )}
                </Field>
                <Field label="Teaching points">
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={2}
                      value={p.teachingPoints.join("\n")}
                      onChange={(e) =>
                        patchProposal(i, {
                          teachingPoints: e.target.value
                            .split("\n")
                            .map((s) => s.trimEnd())
                            .slice(0, LIMITS.teachingPoints),
                        })
                      }
                    />
                  )}
                </Field>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      {proposals.length > 0 && (
        <>
          <Button
            className="mt-3 w-full"
            leadingIcon={<Check className="h-4 w-4" />}
            onClick={saveAll}
            loading={saving}
            disabled={notesMode && !proposals.some((p) => p.label.trim())}
          >
            Save {proposals.length} finding{proposals.length === 1 ? "" : "s"} to sequence
          </Button>
          {notesMode && !proposals.some((p) => p.label.trim()) && (
            <p className="mt-2 text-center text-[11px] text-muted">
              Add a label. Save builds the teach script from this track and your notes.
            </p>
          )}
        </>
      )}

      {!proposals.length && !recording && !structuring && (
        <p className="mt-3 flex items-start gap-2 text-[11px] text-muted">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          Tip: name each lesion as you go (“first, the caudate… next, the
          putamen…”) so segmentation stays faithful.
        </p>
      )}

      {recording && (
        <p className="mt-3 flex items-center gap-2 text-xs text-danger">
          <Mic className="h-3.5 w-3.5" />
          {rr.micCapture === "unavailable"
            ? "Session live — viewer events are timestamped. Save will teach from your notes."
            : rr.micCapture === "live"
              ? "Session live — viewer events are timestamped with your voice."
              : "Session live — viewer events are timestamped."}
        </p>
      )}
    </Card>
  );
}
