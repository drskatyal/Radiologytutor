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
  /**
   * Visible label rendered inside the control, so the words and the mic are
   * one button. A non-empty string becomes the accessible name while idle.
   */
  label?: React.ReactNode;
  /** `sm` — a 36px disc with the label for screen readers only (slim bars). */
  size?: "md" | "sm";
  className?: string;
}

/** Accessible name for the mic control. Idle string labels win; other states keep the action name. */
export function micButtonAccessibleName(state: MicState, label?: React.ReactNode): string {
  if (state === "recording") return "Stop recording";
  if (state === "processing") return "Processing audio";
  if (typeof label === "string" && label.trim()) return label;
  return "Start recording";
}

/**
 * Polished push-to-talk control. Stateless w.r.t. audio — it only reflects the
 * `state` prop and fires `onStart`/`onStop`. Three states: idle, recording
 * (red, pulsing), processing (spinner). The label is inside the button.
 */
export function MicButton({
  state,
  onStart,
  onStop,
  disabled = false,
  label,
  className,
  size = "md",
}: MicButtonProps) {
  const small = size === "sm";
  const reduce = useReducedMotion();
  const isRecording = state === "recording";
  const isProcessing = state === "processing";

  const handleClick = () => {
    if (disabled || isProcessing) return;
    if (isRecording) onStop();
    else onStart();
  };

  const ariaLabel = micButtonAccessibleName(state, label);
  const visibleLabel =
    label ??
    (isRecording ? "Listening…" : isProcessing ? "Thinking…" : "Hold to ask");
  const idle = !isRecording && !isProcessing;

  return (
    <div className={cn("flex", className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-pressed={isRecording}
        disabled={disabled || isProcessing}
        onClick={handleClick}
        className={cn(
          "group inline-flex items-center rounded-full text-left",
          small ? "gap-0" : "gap-3",
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
      >
        <span className="relative shrink-0">
          {/* Soft halo behind the idle disc — calm, premium, draws the eye. */}
          {idle && !reduce && (
            <motion.span
              aria-hidden="true"
              className="absolute inset-0 -z-10 rounded-full bg-accent/30 blur-md"
              animate={{ opacity: [0.4, 0.75, 0.4], scale: [0.95, 1.08, 0.95] }}
              transition={{ duration: 3, ease: "easeInOut", repeat: Infinity }}
            />
          )}
          <span
            className={cn(
              "relative flex items-center justify-center rounded-full transition duration-200",
              small ? "h-9 w-9" : "h-14 w-14",
              idle && !reduce && "group-hover:scale-105 group-active:scale-[0.93]",
              isRecording
                ? "animate-mic-pulse bg-danger text-white"
                : isProcessing
                  ? "bg-elevated text-secondary"
                  : "bg-accent text-accent-foreground shadow-sm group-hover:brightness-[1.05]"
            )}
          >
            {isProcessing ? (
              <Spinner size="md" label="Processing" />
            ) : isRecording ? (
              <Square className={cn("fill-current", small ? "h-3.5 w-3.5" : "h-5 w-5")} strokeWidth={0} />
            ) : (
              <Mic className={small ? "h-4 w-4" : "h-6 w-6"} />
            )}
          </span>
        </span>
        <span
          className={cn(
            "text-sm font-medium tabular-nums",
            small && "sr-only",
            isRecording ? "text-danger" : "text-secondary"
          )}
        >
          {visibleLabel}
        </span>
      </button>
    </div>
  );
}
