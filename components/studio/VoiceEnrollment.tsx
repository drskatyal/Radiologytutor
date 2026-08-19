"use client";

// Teacher voice enrollment — Instant Voice Clone for the AI tutor’s live voice.
// Capture tracks arm the model with reading craft; students talk to the tutor,
// they do not listen to a frozen walk-through tape.

import { useCallback, useEffect, useState } from "react";
import { AudioLines, CheckCircle2, CircleAlert, Mic } from "lucide-react";
import {
  Badge,
  Button,
  Field,
  MicButton,
  useToast,
  type MicState,
} from "@/components/ui";
import { useRecorder } from "@/components/useRecorder";
import type { AuthorVoice } from "@/lib/types";

type VoiceStatusResponse = {
  authorId: string | null;
  voice: AuthorVoice;
  elevenLabsConfigured: boolean;
};

export function VoiceEnrollment({ authorName }: { authorName: string }) {
  const { toast } = useToast();
  const recorder = useRecorder();
  const [voice, setVoice] = useState<AuthorVoice>({
    provider: "elevenlabs",
    status: "none",
  });
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [consent, setConsent] = useState(false);
  const [mic, setMic] = useState<MicState>("idle");
  const [sample, setSample] = useState<{
    base64: string;
    mimeType: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/studio/voice");
      const data = (await res.json()) as VoiceStatusResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setVoice(data.voice ?? { provider: "elevenlabs", status: "none" });
      setConfigured(Boolean(data.elevenLabsConfigured));
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't load voice status",
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onMicStart() {
    try {
      await recorder.start();
      setMic("recording");
    } catch {
      toast({
        variant: "warning",
        title: "Microphone blocked",
        description: "Allow mic access to record a teaching sample.",
      });
    }
  }

  async function onMicStop() {
    setMic("processing");
    const rec = await recorder.stop();
    setMic("idle");
    if (!rec) return;
    setSample({ base64: rec.base64, mimeType: rec.mimeType });
    toast({
      variant: "success",
      title: "Sample captured",
      description: "Record 30–90s of clear teaching speech for best clone quality.",
    });
  }

  async function enroll() {
    if (!consent) {
      toast({
        variant: "warning",
        title: "Consent required",
        description: "Confirm learners may hear a synthetic voice modeled on your samples.",
      });
      return;
    }
    if (!sample) {
      toast({
        variant: "warning",
        title: "Record a sample first",
        description: "Hold the mic and speak as you would while teaching a case.",
      });
      return;
    }
    setEnrolling(true);
    try {
      const res = await fetch("/api/studio/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consent: true,
          name: `${authorName || "Teacher"} (FlowRad tutor)`,
          samples: [
            {
              base64: sample.base64,
              mimeType: sample.mimeType,
              filename: "teaching-sample.webm",
            },
          ],
        }),
      });
      const data = (await res.json()) as {
        voice?: AuthorVoice;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (data.voice) setVoice(data.voice);
      setSample(null);
      toast({
        variant: "success",
        title: "Teaching voice ready",
        description: "Live Q&A will speak in your cloned voice. Recorded walk-throughs stay your real mic.",
      });
    } catch (e) {
      toast({
        variant: "danger",
        title: "Couldn't create voice clone",
        description: (e as Error).message,
      });
      void refresh();
    } finally {
      setEnrolling(false);
    }
  }

  const statusBadge =
    voice.status === "ready" ? (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Clone ready
      </Badge>
    ) : voice.status === "pending" ? (
      <Badge variant="warning">Cloning…</Badge>
    ) : voice.status === "failed" ? (
      <Badge variant="danger">Clone failed</Badge>
    ) : (
      <Badge variant="neutral">Not enrolled</Badge>
    );

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-subtle bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
            <AudioLines className="h-4 w-4 text-accent" aria-hidden="true" />
            Teaching voice
          </h3>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            Live tutor answers can speak in a synthetic voice modeled on your
            teaching samples. Walk-through recordings always keep your real mic.
          </p>
        </div>
        {statusBadge}
      </div>

      {!configured && !loading && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-secondary">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <p>
            Set <code className="text-primary">ELEVENLABS_API_KEY</code> to enable
            cloning. Until then, live Q&A uses Gemini TTS.
          </p>
        </div>
      )}

      {voice.status === "ready" && voice.voiceId && (
        <p className="text-xs text-secondary tabular-nums">
          Voice id <span className="text-muted">{voice.voiceId.slice(0, 12)}…</span>
          {voice.clonedAt && (
            <> · enrolled {new Date(voice.clonedAt).toLocaleDateString()}</>
          )}
        </p>
      )}

      <Field
        label="Sample take"
        hint="30–90 seconds of clear speech — how you teach at the workstation."
      >
        {() => (
          <div className="flex flex-wrap items-center gap-3">
            <MicButton
              state={mic}
              onStart={() => void onMicStart()}
              onStop={() => void onMicStop()}
              label={
                sample ? (
                  <span className="inline-flex items-center gap-1.5 text-success">
                    <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                    Sample ready — re-record anytime
                  </span>
                ) : undefined
              }
            />
          </div>
        )}
      </Field>

      <label className="flex cursor-pointer items-start gap-2.5 text-xs text-secondary">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 rounded border-strong bg-elevated text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>
          I consent to FlowRad creating a synthetic teaching voice from my
          samples for live Q&A. Students will see a disclosure. Recorded case
          narration remains my original audio.
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => void enroll()}
          loading={enrolling}
          disabled={!configured || loading}
        >
          {voice.status === "ready" ? "Re-enroll voice" : "Create teaching voice"}
        </Button>
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          Refresh status
        </Button>
      </div>
    </section>
  );
}
