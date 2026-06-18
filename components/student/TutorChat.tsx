"use client";

// The tutor chat transcript + composer. Renders user/assistant turns (animated
// in with fade-up), an interim-status pill that reflects the voice pipeline
// (recording → transcribing → thinking → speaking), a text input, and the
// push-to-talk MicButton. The student can ask at any step without losing place.

import { useEffect, useRef, useState } from "react";
import { Button, Input, MicButton, Spinner, cn, type MicState } from "@/components/ui";
import type { ChatSource, ChatTurn, SessionPhase } from "./useStudentSession";

const PHASE_LABEL: Partial<Record<SessionPhase, string>> = {
  recording: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Tutor is thinking…",
  speaking: "Speaking…",
};

export function TutorChat({
  turns,
  phase,
  micState,
  micSupported,
  busy,
  onSend,
  onMicStart,
  onMicStop,
  onStopSpeaking,
}: {
  turns: ChatTurn[];
  phase: SessionPhase;
  micState: MicState;
  micSupported: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onMicStart: () => void;
  onMicStop: () => void;
  onStopSpeaking: () => void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest turn / status in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, phase]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    onSend(text);
  };

  const statusLabel = PHASE_LABEL[phase];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {turns.map((t) => (
          <ChatBubble key={t.id} turn={t} />
        ))}
        {statusLabel && (
          <div className="flex animate-fade-up items-center gap-2 text-xs text-muted">
            <Spinner size="sm" label={statusLabel} />
            {statusLabel}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="space-y-3 border-t border-subtle p-4">
        <div className="flex items-center gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            onFocus={onStopSpeaking}
            placeholder="Ask the tutor, or say “next”…"
            aria-label="Ask the tutor"
            disabled={busy}
          />
          <Button onClick={submit} disabled={busy || !input.trim()}>
            Send
          </Button>
        </div>

        {micSupported ? (
          <div className="flex items-center justify-center rounded-lg border border-subtle bg-surface/60 py-3">
            <MicButton
              state={micState}
              onStart={onMicStart}
              onStop={onMicStop}
              disabled={busy && micState !== "recording"}
            />
          </div>
        ) : (
          <p className="text-center text-xs text-muted">
            Voice input isn’t supported in this browser — type your question above.
          </p>
        )}
      </div>
    </div>
  );
}

function ChatBubble({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  const hasSources = !isUser && !turn.error && (turn.sources?.length ?? 0) > 0;
  return (
    <div className={cn("flex animate-fade-up", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[85%] flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
            isUser
              ? "bg-accent text-accent-foreground"
              : turn.error
                ? "border border-danger/30 bg-danger/10 text-primary"
                : "border border-subtle bg-elevated text-primary"
          )}
        >
          {turn.voice && isUser && (
            <span className="mr-1.5 inline-flex translate-y-0.5 text-accent-foreground/80" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
              </svg>
            </span>
          )}
          {turn.pending ? (
            <span className="inline-flex items-center gap-1.5 opacity-80">
              <Spinner size="sm" label="Transcribing" />
              transcribing…
            </span>
          ) : (
            turn.text
          )}
        </div>
        {hasSources && <SourceChips sources={turn.sources!} />}
      </div>
    </div>
  );
}

// Compact, tasteful citation chips for a tutor turn's web sources (from Google
// Search grounding). Each opens its source in a new tab; a favicon (with a
// globe fallback) and a truncated title keep them tidy. Animated in.
function SourceChips({ sources }: { sources: ChatSource[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((s, i) => (
        <SourceChip key={`${s.url}-${i}`} source={s} />
      ))}
    </div>
  );
}

function SourceChip({ source }: { source: ChatSource }) {
  const [iconError, setIconError] = useState(false);
  let host = "";
  try {
    host = new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    host = source.url;
  }
  const label = source.title && source.title !== source.url ? source.title : host;

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} — ${host}`}
      className={cn(
        "inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border border-subtle bg-surface/70 px-2.5 py-1",
        "text-xs text-secondary transition-colors hover:border-strong hover:bg-elevated hover:text-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      )}
    >
      {iconError ? (
        <GlobeIcon />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
          alt=""
          width={14}
          height={14}
          className="h-3.5 w-3.5 shrink-0 rounded-sm"
          onError={() => setIconError(true)}
        />
      )}
      <span className="truncate">{label}</span>
    </a>
  );
}

function GlobeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-3.5 w-3.5 shrink-0 text-muted"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" strokeLinecap="round" />
    </svg>
  );
}
