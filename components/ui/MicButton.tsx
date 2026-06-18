"use client";

import { cn } from "./cn";
import { Spinner } from "./Spinner";

export type MicState = "idle" | "recording" | "processing";

export interface MicButtonProps {
  state: MicState;
  /** Called when the user begins recording (idle → recording). */
  onStart: () => void;
  /** Called when the user ends recording (recording → processing/idle). */
  onStop: () => void;
  disabled?: boolean;
  /** Optional label rendered beside the button. */
  label?: React.ReactNode;
  className?: string;
}

const MicIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
  </svg>
);

const StopIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);

/**
 * Polished push-to-talk control. Stateless w.r.t. audio — it only reflects the
 * `state` prop and fires `onStart`/`onStop`. Three states: idle, recording
 * (red, pulsing), processing (spinner).
 */
export function MicButton({
  state,
  onStart,
  onStop,
  disabled = false,
  label,
  className,
}: MicButtonProps) {
  const isRecording = state === "recording";
  const isProcessing = state === "processing";

  const handleClick = () => {
    if (disabled || isProcessing) return;
    if (isRecording) onStop();
    else onStart();
  };

  const ariaLabel = isRecording
    ? "Stop recording"
    : isProcessing
      ? "Processing audio"
      : "Start recording";

  const defaultLabel = isRecording
    ? "Listening…"
    : isProcessing
      ? "Thinking…"
      : "Hold to ask";

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-pressed={isRecording}
        disabled={disabled || isProcessing}
        onClick={handleClick}
        className={cn(
          "relative flex h-14 w-14 items-center justify-center rounded-full transition-all duration-200",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          "disabled:cursor-not-allowed disabled:opacity-60",
          isRecording
            ? "animate-mic-pulse bg-danger text-white"
            : isProcessing
              ? "bg-elevated text-secondary"
              : "bg-accent text-accent-foreground hover:bg-accent/90 hover:scale-105 active:scale-95 shadow-md"
        )}
      >
        {isProcessing ? (
          <Spinner size="md" label="Processing" />
        ) : isRecording ? (
          StopIcon
        ) : (
          MicIcon
        )}
      </button>
      <span
        className={cn(
          "text-sm font-medium tabular-nums",
          isRecording ? "text-danger" : "text-secondary"
        )}
      >
        {label ?? defaultLabel}
      </span>
    </div>
  );
}
