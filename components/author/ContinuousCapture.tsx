"use client";

// ContinuousCapture — harness demonstration UI ("speak once" authoring).
//
// The radiologist scrolls/windows/clicks while holding one mic take. We record
// the full viewer event log + audio on one clock. On stop, Gemini segments the
// dictation into structured findings (JSON schema) with time ranges; then
// mergeCaptureDemonstration aligns each segment to the DICOM track and we
// persist Findings + CaptureSession — the teaching script the AI teammate follows.

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
import {
  AiUnavailableError,
  LIMITS,
  structureSession,
  uploadAudio,
  addFinding,
  saveCaptureSession,
} from "@/components/author/lib";
import { mergeCaptureDemonstration } from "@/lib/harness/mergeCapture";
import { withDisplaySnapshot } from "@/lib/findingDisplayState";
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
    audio: { base64: string; mimeType: string };
  } | null>(null);

  const recording = rr.phase === "recording";

  async function start() {
    setNotice("");
    setProposals([]);
    setTranscript("");
    try {
      await rr.startRecording();
      setMicState("recording");
    } catch {
      toast({
        variant: "warning",
        title: "Couldn't start capture",
        description: "Allow microphone access, then try again.",
      });
      setMicState("idle");
    }
  }

  async function stop() {
    setMicState("processing");
    const captured = await rr.stopRecording();
    if (!captured?.track || !captured.audio) {
      setMicState("idle");
      setNotice("Nothing captured — hold the mic while you scroll and speak.");
      return;
    }
    const { track, audio } = captured;
    setLastTake({ track, audio });
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

  async function saveAll() {
    if (!proposals.length || saving) return;
    const parentTrack = lastTake?.track ?? (rr.track as RecordedTrack | null);
    const takeAudio = lastTake?.audio ?? rr.audio;
    if (!parentTrack) {
      toast({ variant: "warning", title: "No recorded track to attach" });
      return;
    }
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

  return (
    <Card padded={false} className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Layers className="h-4 w-4 text-accent" aria-hidden="true" />
          Speak once — structure many
        </h2>
        {recording && (
          <Badge variant="danger" dot>
            Capturing
          </Badge>
        )}
      </div>

      <p className="mb-3 text-xs leading-relaxed text-muted">
        Scroll the study and narrate every finding in one take. We timestamp the
        viewer + your voice, structure JSON findings, then merge them into the
        teaching script the AI attending will drive.
      </p>

      <div className="rounded-xl border border-subtle bg-surface/80 px-3 py-3">
        <MicButton
          state={structuring ? "processing" : micState}
          onStart={start}
          onStop={stop}
          disabled={structuring || saving || rr.phase === "replaying"}
          label={
            recording
              ? "Capturing — keep scrolling & speaking…"
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
          {proposals.map((p, i) => (
            <li
              key={`${p.tStartMs}-${i}`}
              className="rounded-xl border border-subtle bg-elevated/40 p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <Badge variant="accent">
                  {(p.tStartMs / 1000).toFixed(1)}s – {(p.tEndMs / 1000).toFixed(1)}s
                </Badge>
                <div className="flex items-center gap-1">
                  {p.suggestedMarker && (
                    <Badge variant="neutral">
                      mark {(p.suggestedMarker.x_pct * 100).toFixed(0)}%,
                      {(p.suggestedMarker.y_pct * 100).toFixed(0)}%
                      {p.suggestedSliceIndex != null
                        ? ` · slice ${p.suggestedSliceIndex + 1}`
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
          ))}
        </ul>
      )}

      {proposals.length > 0 && (
        <Button
          className="mt-3 w-full"
          leadingIcon={<Check className="h-4 w-4" />}
          onClick={saveAll}
          loading={saving}
        >
          Save {proposals.length} finding{proposals.length === 1 ? "" : "s"} to sequence
        </Button>
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
          Session live — viewer events are timestamped with your voice.
        </p>
      )}
    </Card>
  );
}
