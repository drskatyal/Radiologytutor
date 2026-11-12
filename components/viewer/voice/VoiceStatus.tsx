"use client";

// The voice-commands status card, shared by the web and desktop viewers.
//
// Loading shows what is happening and how far (microphone permission, model
// bytes, starting the recognizer) — a real progress bar, never an endless
// spinner. A failure says why in one actionable line, with Retry. Listening
// shows nothing here (the mic button itself lights up).

import { AlertTriangle, Mic, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { cn } from "@/components/ui/cn";
import type { VoiceProgress, VoiceState } from "./voiceSession";

export interface VoiceStatusProps {
  state: VoiceState;
  progress?: VoiceProgress | null;
  error?: string | null;
  onRetry: () => void;
  onDismiss: () => void;
  className?: string;
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

export function voiceProgressText(p: VoiceProgress | null | undefined): { line: string; value: number | null; valueText?: string } {
  if (!p) return { line: "Starting voice commands…", value: null };
  if (p.stage === "permission") return { line: "Waiting for microphone permission…", value: null };
  if (p.stage === "starting") return { line: "Starting the recognizer…", value: 1 };
  if (p.total > 0) {
    const valueText = `${mb(p.loaded)} of ${mb(p.total)} MB`;
    return { line: `Loading voice model · ${valueText}`, value: p.loaded / p.total, valueText };
  }
  if (p.loaded > 0) return { line: `Loading voice model · ${mb(p.loaded)} MB`, value: null, valueText: `${mb(p.loaded)} MB` };
  return { line: "Loading voice model…", value: null };
}

export function VoiceStatus({ state, progress, error, onRetry, onDismiss, className }: VoiceStatusProps) {
  if (state !== "loading" && state !== "error") return null;
  const loading = state === "loading";
  const text = voiceProgressText(progress);
  return (
    <div
      data-testid="voice-status"
      data-voice-state={state}
      role={loading ? "status" : "alert"}
      aria-live="polite"
      className={cn(
        "w-72 rounded-lg border border-white/15 bg-black/85 p-3 text-xs text-white shadow-lg backdrop-blur-md",
        className
      )}
    >
      <div className="flex items-start gap-2">
        {loading ? (
          <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
        ) : (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
        )}
        <p className="min-w-0 flex-1 leading-snug">{loading ? text.line : error || "Voice commands could not start."}</p>
        <IconButton aria-label={loading ? "Cancel voice commands" : "Dismiss"} size="sm" className="-m-1 h-6 w-6 text-white/70 hover:text-white" onClick={onDismiss}>
          <X />
        </IconButton>
      </div>
      {loading ? (
        <ProgressBar className="mt-2" value={text.value} label="Loading voice commands" valueText={text.valueText} />
      ) : (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="imaging" onClick={onRetry} data-testid="voice-retry">
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
