"use client";

// The tutor's OUTPUT surface + input composer. From top to bottom:
//   • a small status line that names what the agent is doing right now;
//   • the transcript — your words appear instantly; the tutor's answer animates
//     in with citation chips and a ▶ replay-voice control, and is spoken;
//   • the Composer (text + push-to-talk) — the one obvious place to ask.
//
// The big AgentOrb lives in the panel header (StudentSession) so it's always in
// view; this surface stays focused on the conversation.

import { useEffect, useRef, useState } from "react";
import { Badge, Spinner, cn, type MicState } from "@/components/ui";
import { Composer } from "./Composer";
import type { OrbState } from "./AgentOrb";
import type { ChatSource, ChatTurn, SessionPhase } from "./useStudentSession";

const STATUS: Partial<Record<OrbState, string>> = {
  listening: "Listening to you…",
  thinking: "Thinking it through…",
  searching: "Searching trusted medical sources…",
  speaking: "Speaking…",
};

export function TutorChat({
  turns,
  phase,
  orbState,
  micState,
  micSupported,
  busy,
  aiAvailable,
  speakingTurnId,
  onSend,
  onMicStart,
  onMicStop,
  onStopSpeaking,
  onReplayTurn,
  onTypingFocus,
  onTypingBlur,
}: {
  turns: ChatTurn[];
  phase: SessionPhase;
  orbState: OrbState;
  micState: MicState;
  micSupported: boolean;
  busy: boolean;
  aiAvailable: boolean;
  speakingTurnId: string | null;
  onSend: (text: string) => void;
  onMicStart: () => void;
  onMicStop: () => void;
  onStopSpeaking: () => void;
  onReplayTurn: (turn: ChatTurn) => void;
  onTypingFocus: () => void;
  onTypingBlur: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest turn / status in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, phase]);

  const statusLabel = STATUS[orbState];
  const hasTurns = turns.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {!aiAvailable && <AiUnavailableNotice />}

        {!hasTurns && aiAvailable && <ConversationHint />}

        {turns.map((t) => (
          <ChatBubble
            key={t.id}
            turn={t}
            speaking={t.id === speakingTurnId}
            onReplay={() => onReplayTurn(t)}
          />
        ))}

        {statusLabel && (
          <div className="flex animate-fade-up items-center gap-2 text-xs text-secondary" aria-live="polite">
            <Spinner size="sm" label={statusLabel} />
            <span>{statusLabel}</span>
            {orbState === "speaking" && (
              <button
                type="button"
                onClick={onStopSpeaking}
                className="rounded-md px-1.5 py-0.5 text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                Stop
              </button>
            )}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-subtle p-4">
        <Composer
          micState={micState}
          micSupported={micSupported}
          busy={busy}
          recording={micState === "recording"}
          onSend={onSend}
          onMicStart={onMicStart}
          onMicStop={onMicStop}
          onTypingFocus={onTypingFocus}
          onTypingBlur={onTypingBlur}
        />
      </div>
    </div>
  );
}

// A warm first-run nudge so the panel is never an empty void before the first
// question — tells a non-technical student exactly what they can do.
function ConversationHint() {
  return (
    <div className="animate-fade-up rounded-xl border border-subtle bg-elevated/50 p-4">
      <p className="text-sm font-medium text-primary">Ask me anything about this study.</p>
      <p className="mt-1 text-sm text-muted">
        Tap the mic and talk, or type below. Try “What am I looking at?”, “Why does this
        matter?”, or “Teach me to report this.”
      </p>
    </div>
  );
}

// Honest, friendly state when the server has no GEMINI_API_KEY. The chat stays
// usable (the field isn't disabled) and voice quietly falls back to the
// browser's speech engine — we just set expectations.
function AiUnavailableNotice() {
  return (
    <div className="animate-fade-up rounded-xl border border-warning/30 bg-warning/10 p-4">
      <Badge variant="warning" dot>
        Limited mode
      </Badge>
      <p className="mt-2 text-sm text-primary">The AI tutor isn’t configured on this server.</p>
      <p className="mt-1 text-sm text-muted">
        You can still explore every finding using the steps above. Live answers and voice
        transcription need an AI key — once it’s set, the tutor wakes up automatically.
      </p>
    </div>
  );
}

function ChatBubble({
  turn,
  speaking,
  onReplay,
}: {
  turn: ChatTurn;
  speaking: boolean;
  onReplay: () => void;
}) {
  const isUser = turn.role === "user";
  const isAssistant = !isUser && !turn.error;
  const hasSources = isAssistant && (turn.sources?.length ?? 0) > 0;
  const canReplay = isAssistant && !!turn.text;

  return (
    <div className={cn("flex animate-fade-up", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[85%] flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
        {/* Speaker label — clear visual distinction between you and the tutor. */}
        <span
          className={cn(
            "px-1 text-[11px] font-medium uppercase tracking-wide",
            isUser ? "text-muted" : turn.error ? "text-danger/80" : "text-accent"
          )}
        >
          {isUser ? "You" : "Tutor"}
        </span>

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

        {/* Tutor controls: replay voice + citation chips. */}
        {(canReplay || hasSources) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {canReplay && <ReplayVoiceButton speaking={speaking} onClick={onReplay} />}
            {hasSources && <SourceChips sources={turn.sources!} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ▶ Replay the tutor's spoken answer (toggles to ⏹ while it's speaking).
function ReplayVoiceButton({ speaking, onClick }: { speaking: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={speaking ? "Stop voice" : "Replay voice"}
      aria-pressed={speaking}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        speaking
          ? "border-accent/40 bg-accent/15 text-accent"
          : "border-subtle bg-surface/70 text-secondary hover:border-strong hover:text-primary"
      )}
    >
      {speaking ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
          <path d="M8 5v14l11-7z" />
        </svg>
      )}
      {speaking ? "Stop" : "Replay voice"}
    </button>
  );
}

// Compact, tasteful citation chips for a tutor turn's web sources (from Google
// Search grounding). Each opens its source in a new tab; a favicon (with a
// globe fallback) and a truncated title keep them tidy.
function SourceChips({ sources }: { sources: ChatSource[] }) {
  return (
    <>
      {sources.map((s, i) => (
        <SourceChip key={`${s.url}-${i}`} source={s} />
      ))}
    </>
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
