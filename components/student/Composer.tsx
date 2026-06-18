"use client";

// The ONE place a student gives input. A single, clearly-labelled composer that
// pairs a free-text field with push/tap-to-talk voice, so there's never any
// ambiguity about how to ask. Guiding placeholder speaks to non-technical
// learners. Every state (busy / recording / mic unsupported / empty) is
// reflected; the mic and Send button can never both be "live" at once.
//
// Keyboard: Enter submits; the global talk hotkey is suppressed while this
// field is focused (handled by the parent) so typing never triggers the mic.

import { useId, useState } from "react";
import { Button, Input, MicButton, type MicState } from "@/components/ui";

export function Composer({
  micState,
  micSupported,
  busy,
  recording,
  onSend,
  onMicStart,
  onMicStop,
  onTypingFocus,
  onTypingBlur,
}: {
  micState: MicState;
  micSupported: boolean;
  busy: boolean;
  /** True while capturing audio — relaxes the text field's disabled state copy. */
  recording: boolean;
  onSend: (text: string) => void;
  onMicStart: () => void;
  onMicStop: () => void;
  /** Fired when the text field gains focus (parent stops speech + disarms hotkey). */
  onTypingFocus: () => void;
  onTypingBlur: () => void;
}) {
  const [input, setInput] = useState("");
  const fieldId = useId();

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    onSend(text);
  };

  const placeholder = recording
    ? "Listening… release to send"
    : "Ask about this finding — or say “teach me to report this”";

  return (
    <div className="space-y-2.5">
      <label htmlFor={fieldId} className="sr-only">
        Ask the tutor a question
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={fieldId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          onFocus={onTypingFocus}
          onBlur={onTypingBlur}
          placeholder={placeholder}
          aria-label="Ask the tutor a question"
          disabled={busy && !recording}
        />
        <Button
          onClick={submit}
          disabled={busy || !input.trim()}
          aria-label="Send question"
          className="shrink-0"
        >
          Send
        </Button>
      </div>

      {micSupported ? (
        <div className="flex items-center justify-center gap-3 rounded-xl border border-subtle bg-surface/60 py-2.5">
          <MicButton
            state={micState}
            onStart={onMicStart}
            onStop={onMicStop}
            disabled={busy && micState !== "recording"}
            label={
              micState === "recording"
                ? "Listening — tap to send"
                : micState === "processing"
                  ? "Transcribing…"
                  : "Tap to talk"
            }
          />
        </div>
      ) : (
        <p className="rounded-lg border border-subtle bg-surface/60 px-3 py-2 text-center text-xs text-muted">
          Voice input isn’t available in this browser — type your question above.
        </p>
      )}
    </div>
  );
}
