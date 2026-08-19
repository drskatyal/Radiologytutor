"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Mic, Square } from "lucide-react";
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
  const reduce = useReducedMotion();
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
      <div className="relative">
        {/* Soft halo behind the idle button — calm, premium, draws the eye. */}
        {!isRecording && !isProcessing && !reduce && (
          <motion.span
            aria-hidden="true"
            className="absolute inset-0 -z-10 rounded-full bg-accent/30 blur-md"
            animate={{ opacity: [0.4, 0.75, 0.4], scale: [0.95, 1.08, 0.95] }}
            transition={{ duration: 3, ease: "easeInOut", repeat: Infinity }}
          />
        )}
        <motion.button
          type="button"
          aria-label={ariaLabel}
          aria-pressed={isRecording}
          disabled={disabled || isProcessing}
          onClick={handleClick}
          whileTap={reduce ? undefined : { scale: 0.93 }}
          whileHover={reduce || isRecording || isProcessing ? undefined : { scale: 1.05 }}
          className={cn(
            "relative flex h-14 w-14 items-center justify-center rounded-full transition-colors duration-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
            "disabled:cursor-not-allowed disabled:opacity-60",
            isRecording
              ? "animate-mic-pulse bg-danger text-white"
              : isProcessing
                ? "bg-elevated text-secondary"
                : "bg-accent text-accent-foreground shadow-sm hover:brightness-[1.05]"
          )}
        >
          {isProcessing ? (
            <Spinner size="md" label="Processing" />
          ) : isRecording ? (
            <Square className="h-5 w-5 fill-current" strokeWidth={0} />
          ) : (
            <Mic className="h-6 w-6" />
          )}
        </motion.button>
      </div>
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
