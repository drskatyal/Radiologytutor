"use client";

// ContinuousCapture — harness demonstration UI ("speak once" authoring).
//
// The radiologist scrolls/windows/clicks while holding one take. We record the
// viewer event log, viewport stills, and the microphone when it opens, on one
// clock. Finish shows that recording for review and does not compile.
// Process and teach case sends it to Gemini. With no microphone the same
// stop still keeps the viewer track, and Save builds a notes-voiced
// teaching guide from that track and the typed label, description, and points.

import { notesDrafts } from "@/lib/anchors/notes";
import { retainedMarkers, resolveAnchor } from "@/lib/anchors/resolve";
import { reconcileDrafts, type MarkerDecision } from "@/lib/anchors/reconcile";
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
import { type CompileFrame } from "@/lib/compileMedia";
import { RecordedTakeNote } from "@/components/author/RecordedTakeNote";
import {
  AiUnavailableError,
  LIMITS,
  markerFromTrack,
  structureSession,
  uploadAudio,
  uploadTeachingVideo,
  addFinding,
  saveCaptureSession,
  commitLiveTeachingPack,
} from "@/components/author/lib";
import { updateCase } from "@/components/admin/api";
import { materializeLiveTeachingPack, type LiveProse } from "@/lib/liveTeachingPack";
import {
  compileProgressPlan,
  phaseAfterFinish,
  TEACHER_PROCESSING_LABEL,
  useAgenticViewportVideo,
} from "@/lib/teacherCapture";
import type { TeacherReview } from "@/components/author/TakeReview";
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

export type TeacherCapturePhase = "idle" | "recording" | "review" | "processing" | "ready";

export interface TeacherCompileProgress {
  index: number;
  total: number;
  label: string;
}

export type TeacherCaptureApi = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  process: () => Promise<void>;
};

export function ContinuousCapture({
  caseId,
  rr,
  controls,
  seriesInstanceUID,
  studyInstanceUID,
  modality,
  clinicalQuestion,
  diagnosis,
  studySeriesUIDs,
  study,
  adoptExternalTakes = false,
  onCaseUpdated,
  onPhaseChange,
  onProgress,
  onReview,
  onApi,
}: {
  caseId: string;
  rr: RR;
  controls: MutableRefObject<CornerstoneControls | null>;
  seriesInstanceUID?: string;
  studyInstanceUID?: string;
  modality?: string;
  clinicalQuestion?: string;
  diagnosis?: string;
  studySeriesUIDs?: string[];
  /** Case stem sent with the compile call. Not a source of coordinates. */
  study?: {
    title?: string;
    modality?: string;
    specialty?: string;
    clinicalHistory?: string;
    patientAge?: string;
    patientSex?: string;
  };
  /**
   * When true, a take started outside this panel (Alt+X, the studio transport)
   * is compiled on stop. Re-recording one finding leaves this off.
   */
  adoptExternalTakes?: boolean;
  onCaseUpdated: (c: Awaited<ReturnType<typeof addFinding>>) => void;
  onPhaseChange?: (phase: TeacherCapturePhase) => void;
  onProgress?: (progress: TeacherCompileProgress | null) => void;
  /** Viewport recording + log for the studio review player. Null clears it. */
  onReview?: (review: TeacherReview | null) => void;
  onApi?: (api: TeacherCaptureApi | null) => void;
}) {
  const { toast } = useToast();
  const [settling, setSettling] = useState(false);
  const [structuring, setStructuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [proposals, setProposals] = useState<StructuredSessionFinding[]>([]);
  const [markerDecisions, setMarkerDecisions] = useState<MarkerDecision[]>([]);
  const [jumpStatus, setJumpStatus] = useState<Record<string, string>>({});
  const [jumping, setJumping] = useState(false);
  const [notice, setNotice] = useState("");
  const [lastTake, setLastTake] = useState<{
    track: RecordedTrack;
    audio: { base64: string; mimeType: string } | null;
  } | null>(null);

  const markerTake = lastTake?.track && retainedMarkers(lastTake.track.journal ?? []).length > 0;
  const candidates = markerTake ? reconcileDrafts(lastTake!.track, proposals, markerDecisions) : proposals;
  const recording = ["starting", "recording", "stopping"].includes(rr.phase);
  const notesMode = Boolean(lastTake && !lastTake.audio && proposals.length > 0 && !recording);
  // True only after Speak once itself started the take. The transport bar and
  // the Alt+X hotkey call rr.stopRecording() without going through stop(), so
  // the button state is derived from the recorder and this flag adopts the take.
  const speakSession = useRef(false);
  const held = useRef<{
    track: RecordedTrack;
    audio: { base64: string; mimeType: string };
    frames: CompileFrame[];
    videoBlob: Blob | null;
  } | null>(null);

  async function start() {
    setNotice("");
    setProposals([]);
    setMarkerDecisions([]); setJumpStatus({});
    setTranscript("");
    setLastTake(null);
    held.current = null;
    onReview?.(null);
    onProgress?.(null);
    speakSession.current = true;
    onPhaseChange?.("recording");
    try {
      const started = await rr.startRecording();
      if (!started) {
        if (!recording) {
          speakSession.current = false;
          onPhaseChange?.("idle");
        }
        setNotice("The viewer isn't ready yet — wait for the study, then start again.");
      }
    } catch {
      speakSession.current = false;
      onPhaseChange?.("idle");
      toast({
        variant: "warning",
        title: "Couldn't start capture",
        description: "The viewer track didn't start. Try again once the study is open.",
      });
    }
  }

  function openNotesDraft(track: RecordedTrack) {
    setMarkerDecisions([]); setJumpStatus({});
    if (retainedMarkers(track.journal ?? []).length) { setProposals(notesDrafts(track)); setNotice(""); return; }
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

  function publishReview(
    track: RecordedTrack,
    playback: {
      videoUrl?: string | null;
      audioUrl?: string | null;
      videoOffsetMs?: number;
      audioOffsetMs?: number;
    } | null
  ) {
    onReview?.({
      videoUrl: playback?.videoUrl ?? null,
      audioUrl: playback?.audioUrl ?? null,
      videoOffsetMs: playback?.videoOffsetMs ?? 0,
      audioOffsetMs: playback?.audioOffsetMs ?? 0,
      track,
    });
  }

  async function finishStoppedTake(
    captured: {
      track: RecordedTrack;
      audio: { base64: string; mimeType: string } | null;
      frames?: CompileFrame[];
      videoBlob?: Blob | null;
      playback?: {
        videoUrl?: string | null;
        audioUrl?: string | null;
        videoOffsetMs?: number;
        audioOffsetMs?: number;
      } | null;
    } | null
  ) {
    const outcome = phaseAfterFinish({
      hasTrack: Boolean(captured?.track),
      hasAudio: Boolean(captured?.audio),
    });
    if (outcome === "empty" || !captured?.track) {
      onPhaseChange?.("idle");
      onReview?.(null);
      setNotice("Nothing captured — scroll the study, then finish.");
      return;
    }
    const { track, audio, frames } = captured;
    setLastTake({ track, audio });
    if (outcome === "notes" || !audio) {
      held.current = null;
      onPhaseChange?.("idle");
      if (captured.playback?.videoUrl || captured.videoBlob) {
        publishReview(track, captured.playback ?? null);
      } else {
        onReview?.(null);
      }
      openNotesDraft(track);
      return;
    }
    held.current = {
      track,
      audio,
      frames: frames ?? [],
      videoBlob: captured.videoBlob ?? null,
    };
    publishReview(track, captured.playback ?? null);
    onPhaseChange?.("review");
    setNotice("Recording ready. Replay it, then process and teach the case.");
  }

  async function processTake() {
    const take = held.current;
    if (!take || structuring) return;
    const agentic = Boolean(take.videoBlob) && useAgenticViewportVideo(take.track.durationMs);
    const steps = compileProgressPlan(agentic);
    const report = (index: number) =>
      onProgress?.({ index, total: steps.length, label: steps[index] ?? steps[steps.length - 1] });
    setStructuring(true);
    onPhaseChange?.("processing");
    report(0);
    const sessionId = take.track.captureSessionId ?? `cap_${Date.now().toString(36)}`;
    try {
      if (take.track.captureSessionId && !rr.mediaReviewed) throw new Error("Review the captured media for patient identifiers before processing.");
      let audioUrl: string | undefined;
      try {
        audioUrl = await uploadAudio(take.audio.base64, take.audio.mimeType);
      } catch {
        audioUrl = undefined;
      }
      const persisted = await saveCaptureSession(caseId, {
        id: sessionId,
        durationMs: take.track.durationMs,
        track: audioUrl ? { ...take.track, audioUrl } : take.track,
        ...(audioUrl ? { audioUrl } : {}),
        createdAt: new Date().toISOString(),
      });
      onCaseUpdated(persisted);

      report(1);
      let video: { fileUri: string; mimeType: string } | undefined;
      if (agentic && take.videoBlob) {
        try {
          video = await uploadTeachingVideo(caseId, sessionId);
        } catch (err) {
          if (err instanceof AiUnavailableError) throw err;
          video = undefined;
          toast({
            variant: "warning",
            title: "Viewport video wasn't uploaded",
            description: "Compiling from the viewer log and stills instead.",
          });
        }
      }

      report(2);
      const result = await structureSession({
        audioBase64: take.audio.base64,
        audioMime: take.audio.mimeType,
        durationMs: take.track.durationMs,
        track: take.track,
        frames: video ? undefined : take.frames,
        video,
        study,
        caseId,
        modality: modality || study?.modality,
        clinicalQuestion,
        diagnosis,
        studySeriesUIDs,
      });
      if (!result) {
        onPhaseChange?.("review");
        setNotice(
          "AI structuring is off (no Gemini key). The recording is saved. You can still type a walk-through below."
        );
        return;
      }
      setTranscript(result.transcript);
      if (!result.findings.length && !retainedMarkers(take.track.journal ?? []).length) {
        onPhaseChange?.("review");
        setNotice("No findings detected in the recording — try naming each lesion as you scroll.");
        return;
      }
      report(3);
      const updated = await commitLiveTeachingPack(caseId, {
        captureSessionId: sessionId,
        transcript: result.transcript,
        seriesInstanceUID,
        studyInstanceUID,
        findings: reconcileDrafts(take.track, result.findings).map((finding) => ({
          markerId: finding.markerId,
          label: finding.label,
          description: finding.description,
          teachingPoints: finding.teachingPoints,
          whatToNotice: finding.whatToNotice,
          pearl: finding.pearl,
          mimics: finding.mimics,
          clinicalImportance: finding.clinicalImportance,
          whyClinicallyFirst: finding.whyClinicallyFirst,
          reportLine: finding.reportLine,
          landmark: finding.landmark,
          tStartMs: finding.tStartMs,
          tEndMs: finding.tEndMs,
        })),
      });
      onCaseUpdated(updated);
      setProposals([]);
      onProgress?.(null);
      onPhaseChange?.("ready");
      const count = updated.liveTeachingPack?.findings.length ?? result.findings.length;
      setNotice(
        `Teaching pack ready — ${count} finding${count === 1 ? "" : "s"} ordered by clinical importance.`
      );
      toast({
        variant: "success",
        title: "Teaching pack ready",
        description: "Test as student, then add the case to your library.",
      });
    } catch (e) {
      onPhaseChange?.("review");
      onProgress?.(null);
      if (e instanceof AiUnavailableError) {
        setNotice(e.message);
      } else {
        toast({
          variant: "danger",
          title: "Couldn't compile the teaching pack",
          description: e instanceof Error ? e.message : undefined,
        });
      }
    } finally {
      setStructuring(false);
    }
  }

  const finishRef = useRef(finishStoppedTake);
  finishRef.current = finishStoppedTake;
  const processRef = useRef(processTake);
  processRef.current = processTake;
  const apiRef = useRef({
    start,
    stop: async () => {},
    process: async () => {},
  });
  apiRef.current.start = start;
  apiRef.current.process = () => processRef.current();

  useEffect(() => {
    onApi?.({
      start: () => apiRef.current.start(),
      stop: () => apiRef.current.stop(),
      process: () => apiRef.current.process(),
    });
    return () => onApi?.(null);
  }, [onApi]);

  const adoptedRecovery = useRef("");
  useEffect(() => {
    if (!rr.recoveredSessionId || adoptedRecovery.current === rr.recoveredSessionId || rr.phase !== "idle" || !rr.track) return;
    adoptedRecovery.current = rr.recoveredSessionId;
    void finishRef.current({ track: rr.track, audio: rr.audio, frames: rr.frames, videoBlob: rr.playback?.videoBlob ?? null, playback: rr.playback ?? null });
  }, [rr.recoveredSessionId, rr.phase, rr.track, rr.audio, rr.frames, rr.playback]);

  useEffect(() => {
    if (adoptExternalTakes && recording) speakSession.current = true;
  }, [adoptExternalTakes, recording]);

  useEffect(() => {
    if (recording || !speakSession.current) return;
    speakSession.current = false;
    const playback = rr.playback;
    const captured = rr.track
      ? {
          track: rr.track,
          audio: rr.audio,
          frames: rr.frames,
          videoBlob: playback?.videoBlob ?? null,
          playback,
        }
      : null;
    void finishRef.current(captured);
  }, [recording, rr.track, rr.audio, rr.frames, rr.playback]);

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
  apiRef.current.stop = stop;

  function patchProposal(i: number, patch: Partial<StructuredSessionFinding>) {
    const markerId = candidates[i]?.markerId;
    setProposals(prev => prev.map((p, idx) => (markerId ? p.markerId === markerId : idx === i) ? { ...p, ...patch } : p));
  }
  function candidateIds(i: number): string[] {
    const p = candidates[i] as (StructuredSessionFinding & { markerIds?: string[] }) | undefined;
    return p?.markerIds ?? (p?.markerId ? [p.markerId] : []);
  }
  function removeProposal(i: number) {
    const ids = candidateIds(i);
    if (ids.length) setMarkerDecisions(prev => [...prev.filter(d => !d.markerIds.some(id => ids.includes(id))), { kind: "omit", markerIds: ids, reason: "Omitted by author in take review" }]);
    else setProposals(prev => prev.filter((_, idx) => idx !== i));
  }
  function groupProposal(i: number) {
    const ids = [...candidateIds(i), ...candidateIds(i + 1)];
    if (ids.length < 2) return;
    setMarkerDecisions(prev => [...prev.filter(d => !d.markerIds.some(id => ids.includes(id))), { kind: "group", markerIds: ids, reason: "Grouped by author as views of one finding" }]);
  }
  async function jumpProposal(p: StructuredSessionFinding) {
    const a = resolveAnchor(p.markerId, lastTake?.track.journal ?? []);
    const viewer = controls.current;
    const current = viewer?.getRenderedView?.()?.snapshot;
    if (a.anchorStatus !== "resolved" || !a.snapshot || !viewer?.requestView || !current) return;
    const id = p.markerId!; setJumping(true); setJumpStatus(prev => ({ ...prev, [id]: "Waiting for render…" }));
    try {
      await viewer.requestView({ commandId: crypto.randomUUID(), generation: 0, snapshot: { ...a.snapshot, viewportId: current.viewportId }, timeoutMs: 5000 });
      setJumpStatus(prev => ({ ...prev, [id]: "Rendered and confirmed" }));
    } catch { setJumpStatus(prev => ({ ...prev, [id]: "Image not confirmed. Check the series and retry." })); }
    finally { setJumping(false); }
  }
  async function saveJournalDrafts(parentTrack: RecordedTrack, notes: boolean) {
    if (!parentTrack.captureSessionId || candidates.some(p => !p.label.trim())) return;
    setSaving(true);
    try {
      await saveCaptureSession(caseId, { id: parentTrack.captureSessionId, durationMs: parentTrack.durationMs, track: parentTrack, transcript, createdAt: new Date().toISOString() });
      const updated = await commitLiveTeachingPack(caseId, { captureSessionId: parentTrack.captureSessionId, transcript, markerDecisions, findings: candidates, ...(notes ? { voice: "notes" as const } : {}) });
      onCaseUpdated(updated);
      toast({ variant: "success", title: "Draft findings saved", description: `${candidates.length} candidates; every retained marker is assigned or explicitly omitted.` });
      setProposals([]); setMarkerDecisions([]); setLastTake(null); setTranscript(""); setNotice(""); rr.reset();
    } catch (e) { toast({ variant: "danger", title: "Couldn't save findings", description: e instanceof Error ? e.message : undefined }); }
    finally { setSaving(false); }
  }

  async function saveNotes(parentTrack: RecordedTrack) {
    if (parentTrack.captureSessionId && parentTrack.journal?.length) { await saveJournalDrafts(parentTrack, true); return; }
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
      const sessionId = parentTrack.captureSessionId ?? `cap_${Date.now().toString(36)}`;
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
    if (parentTrack.captureSessionId && parentTrack.journal?.length) { await saveJournalDrafts(parentTrack, false); return; }
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
        const prose: LiveProse[] = proposals.map((item) => ({
          tStartMs: item.tStartMs,
          label: item.label,
          whatToNotice: item.whatToNotice,
          pearl: item.pearl,
          mimics: item.mimics,
          clinicalImportance: item.clinicalImportance,
          whyClinicallyFirst: item.whyClinicallyFirst,
          reportLine: item.reportLine,
          landmark: item.landmark,
        }));
        try {
          const packed = await updateCase(caseId, {
            liveTeachingPack: materializeLiveTeachingPack({
              caseId,
              modality: modality || updated.modality,
              clinicalQuestion,
              diagnosis,
              findings: updated.findings,
              prose,
              prior: updated.liveTeachingPack,
              studySeriesUIDs,
            }),
          });
          updated = packed;
        } catch {
          /* Findings are already saved. The session rebuilds a pack from them. */
        }
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
        Scroll the study and narrate every finding in one take. Finish recording
        shows the viewport video and the viewer log so you can replay them.
        Process and teach case compiles the pack. Viewport stills and the
        microphone share one clock. Without a microphone the track still
        records and Save teaches from notes.
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
                ? "Capturing — keep scrolling and speaking…"
                : rr.micCapture === "unavailable"
                  ? "Capturing the viewer — no microphone"
                  : "Capturing the viewer…"
              : structuring || settling
                ? TEACHER_PROCESSING_LABEL
                : "Start recording"
          }
        />
      </div>

      {notice && (
        <p className="mt-3 rounded-lg border border-subtle bg-canvas/40 px-3 py-2 text-xs text-secondary">
          {notice}
        </p>
      )}

      {structuring && (
        <div className="mt-3 flex items-center gap-2 text-sm text-secondary" role="status">
          <Spinner size="sm" label={TEACHER_PROCESSING_LABEL} />
          {TEACHER_PROCESSING_LABEL}
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

      {markerTake && <div className="mt-3 space-y-2">
        <p className="text-xs text-secondary">{retainedMarkers(lastTake!.track.journal ?? []).length} retained markers · {candidates.length} draft candidates · {markerDecisions.filter(d => d.kind === "omit").flatMap(d => d.markerIds).length} explicitly omitted</p>
        {markerDecisions.length > 0 && <Button size="sm" variant="ghost" disabled={saving} onClick={() => setMarkerDecisions([])}>Reset grouping and omissions</Button>}
      </div>}
      {proposals.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {candidates.map((p, i) => {
            const anchor = resolveAnchor(p.markerId, lastTake?.track.journal ?? []);
            const guide = guideFor(p);
            return (
            <li
              data-testid="marker-candidate"
              data-marker-id={p.markerId}
              key={p.markerId ?? `${p.tStartMs}-${i}`}
              className="rounded-xl border border-subtle bg-elevated/40 p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <Badge variant="accent">
                  {(p.tStartMs / 1000).toFixed(1)}s – {(p.tEndMs / 1000).toFixed(1)}s
                </Badge>
                <div className="flex flex-wrap items-center gap-1">
                  {p.markerId && <>
                    <Badge variant={anchor.anchorStatus === "resolved" ? "neutral" : "warning"}>{anchor.anchorStatus === "resolved" ? `Frame ${anchor.snapshot!.frame} · ${anchor.calibration}` : "Unresolved anchor"}</Badge>
                    <Button size="sm" variant="secondary" disabled={jumping || anchor.anchorStatus !== "resolved"} onClick={() => void jumpProposal(p)} aria-label={`Jump to candidate ${i + 1}`}>Jump</Button>
                    {i + 1 < candidates.length && <Button size="sm" variant="ghost" disabled={saving} onClick={() => groupProposal(i)}>Group with next</Button>}
                  </>}
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
                    disabled={saving}
                    onClick={() => removeProposal(i)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {p.markerId && jumpStatus[p.markerId] && <p role="status" className="mb-2 text-xs text-secondary">{jumpStatus[p.markerId]}</p>}
              <div className="flex flex-col gap-2">
                <Field label="Label" required>
                  {(props) => (
                    <Input
                      {...props}
                      value={p.label}
                      disabled={saving}
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
                      disabled={saving}
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
                      disabled={saving}
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
            disabled={candidates.some(p => !p.label.trim()) || saving}
          >
            Save {candidates.length} finding{candidates.length === 1 ? "" : "s"} to sequence
          </Button>
          {notesMode && candidates.some(p => !p.label.trim()) && (
            <p className="mt-2 text-center text-[11px] text-muted">
              Add a label to every candidate. Save builds the teach script from this track and your notes.
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
