"use client";

// What the mic is doing, over the image: a real progress bar while the
// recognizer loads (never an endless spinner), the reason and a Retry when it
// could not start. Shared by the web viewer and the desktop app.

import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import type { VoiceProgress, VoiceState } from "./voiceSession";

export function VoiceStatus({
  state,
  progress,
  detail,
  onRetry,
  onDismiss,
  className,
}: {
  state: VoiceState;
  progress?: VoiceProgress | null;
  detail?: string | null;
  onRetry: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  if (state !== "loading" && state !== "error") return null;
  const fraction = progress?.fraction;
  const percent = fraction != null ? Math.round(fraction * 100) : null;
  return (
    <div
      data-testid="voice-status"
      role={state === "error" ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "pointer-events-auto w-72 max-w-[calc(100%-1rem)] rounded-lg border border-white/10 bg-black/85 p-3 text-white shadow-xl backdrop-blur",
        className
      )}
    >
      {state === "loading" ? (
        <>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium">{progress?.label ?? "Loading voice model…"}</span>
            {percent != null && progress?.phase === "model" ? (
              <span className="tabular-nums text-white/60">{percent}%</span>
            ) : null}
          </div>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-label="Voice commands loading"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            {percent != null && progress?.phase === "model" ? (
              <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
            ) : (
              // Unpacking / waiting for the permission prompt: no byte count to show.
              <div className="h-full w-1/3 animate-[voice-indeterminate_1.1s_ease-in-out_infinite] rounded-full bg-accent" />
            )}
          </div>
        </>
      ) : (
        <>
          <p className="text-xs font-medium">Voice commands could not start</p>
          <p className="mt-1 text-xs text-white/70">{detail ?? "Something went wrong."}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="imaging" onClick={onRetry}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" className="text-white/70 hover:text-white" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
