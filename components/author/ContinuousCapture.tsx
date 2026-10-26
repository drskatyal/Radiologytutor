"use client";

// ContinuousCapture — harness demonstration UI ("speak once" authoring).
//
// The radiologist scrolls/windows/clicks while holding one take. We record the
// viewer event log, viewport stills, and the microphone when it opens, on one
// clock. On stop, Gemini Flash compiles structured findings from the voice and
// the stills; marker and slice landings come from the track, and
// mergeCaptureDemonstration stores the teach script. With no microphone the
// same stop still keeps the viewer track, and Save builds a notes-voiced
// teaching guide from that track and the typed label, description, and points.

import { useEffect, useRef, useState } from "react";
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
import { COMPILING_FROM_RECORDING, type CompileFrame } from "@/lib/compileMedia";
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

/**
 * The speak-once disc follows the recorder. `settling` only covers the gap
 * while a stop is flushing; it must not keep the red stop square up after
 * the take has ended (the transport bar and Alt+X stop the recorder directly).
 */
export function speakOnceMicState(
  recording: boolean,
  structuring: boolean,
  settling: boolean
): MicState {
  if (structuring || settling) return "processing";
  if (recording) return "recording";
  return "idle";
}

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
  const [settling, setSettling] = useState(false);
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
  // True only after Speak once itself started the take. The transport bar and
  // the Alt+X hotkey call rr.stopRecording() without going through stop(), so
  // the button state is derived from the recorder and this flag adopts the take.
  const speakSession = useRef(false);

  async function start() {
    setNotice("");
    setProposals([]);
    setTranscript("");
    setLastTake(null);
    speakSession.current = true;
    try {
      const started = await rr.startRecording();
      if (!started) {
        speakSession.current = false;
        setNotice("The viewer isn't ready yet — wait for the study, then start again.");
      }
    } catch {
      speakSession.current = false;
      toast({
        variant: "warning",
        title: "Couldn't start capture",
        description: "The viewer track didn't start. Try again once the study is open.",
      });
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

  async function finishStoppedTake(
    captured: {
      track: RecordedTrack;
      audio: { base64: string; mimeType: string } | null;
      frames?: CompileFrame[];
    } | null
  ) {
    if (!captured?.track) {
      setNotice("Nothing captured — scroll the study, then stop.");
      return;
    }
    const { track, audio, frames } = captured;
    setLastTake({ track, audio });
    if (!audio) {
      openNotesDraft(track);
      return;
    }
    setStructuring(true);
    try {
      const result = await structureSession({
        audioBase64: audio.base64,
        audioMime: audio.mimeType,
        durationMs: track.durationMs,
        track,
        frames,
      });
      if (!result) {
        setNotice(
          "AI structuring is off (no Gemini key). You can still save a single walk-through from the panel below."
        );
        return;
      }
      setTranscript(result.transcript);
      setProposals(result.findings);
      const stills = frames?.length ?? 0;
      setNotice(
        result.findings.length
          ? `Compiled ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} from the recording${stills ? ` and ${stills} viewport still${stills === 1 ? "" : "s"}` : ""} — review fields, then save all.`
          : "No findings detected in the recording — try naming each lesion as you scroll."
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
    }
  }

  const finishRef = useRef(finishStoppedTake);
  finishRef.current = finishStoppedTake;

  useEffect(() => {
    if (recording || !speakSession.current) return;
    speakSession.current = false;
    const captured = rr.track
      ? { track: rr.track, audio: rr.audio, frames: rr.frames }
      : null;
    void finishRef.current(captured);
  }, [recording, rr.track, rr.audio, rr.frames]);

  async function stop() {
    setSettling(true);
    try {
      const captured = await rr.stopRecording();
      if (!captured) {
        speakSession.current = false;
        setNotice("Nothing captured — scroll the study, then stop.");
      }
    } catch {
      speakSession.current = false;
    } finally {
      setSettling(false);
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
        Scroll the study and narrate every finding in one take. With a microphone
        we compile the teaching script from your voice, viewport stills, and the
        viewer log. Without a microphone the viewer track still records, and Save
        teaches from the notes you type.
      </p>

      <div className="rounded-xl border border-subtle bg-surface/80 px-3 py-3">
        <MicButton
          state={speakOnceMicState(recording, structuring, settling)}
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
                ? COMPILING_FROM_RECORDING
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
          {COMPILING_FROM_RECORDING}
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
              ? "Session live — voice, viewport stills, and viewer events share one clock."
              : "Session live — viewer events are timestamped."}
        </p>
      )}
    </Card>
  );
}
