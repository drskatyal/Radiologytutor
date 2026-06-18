"use client";

// /case/[caseId] playback. Clean Pacsbin embed + animated marker overlay +
// AI tutor chat panel. The tutor (server route) emits function calls; we
// execute them here by driving lib/viewerController against the iframe.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ViewerFrame, { type ViewerFrameHandle } from "@/components/ViewerFrame";
import { useRecorder } from "@/components/useRecorder";
import { speak, stopSpeaking } from "@/lib/speak";
import { buildViewerUrl, PLAYBACK_CHROME } from "@/lib/pacsbinUrl";
import { runTransition, runTrack, animateWindow } from "@/lib/viewerController";
import type { CaseData, Finding, Marker, Viewport } from "@/lib/types";

type Mode = "guided" | "socratic" | "free";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export default function PlaybackClient({ caseData }: { caseData: CaseData }) {
  const viewerRef = useRef<ViewerFrameHandle>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [mode, setMode] = useState<Mode>("guided");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [marker, setMarker] = useState<Marker | null>(null);
  const [markerVisible, setMarkerVisible] = useState(false);
  const [started, setStarted] = useState(false);
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);

  // The viewport currently shown — the "from" for the next transition.
  const currentViewportRef = useRef<Viewport>(firstOrEmpty(caseData));
  const tourIndexRef = useRef<number>(-1);

  const recorder = useRecorder();

  const initialSrc = useMemo(
    () => buildViewerUrl(caseData.pacsbinBaseUrl, firstOrEmpty(caseData), PLAYBACK_CHROME),
    [caseData]
  );

  const apply = useCallback((url: string) => {
    viewerRef.current?.setSrc(url);
  }, []);

  const findingById = useCallback(
    (id: string) => caseData.findings.find((f) => f.id === id),
    [caseData]
  );

  const orderedFindings = useMemo(
    () => caseData.findings.slice().sort((a, b) => a.order - b.order),
    [caseData]
  );

  // Execute one tutor tool call (visual side-effects).
  const executeCall = useCallback(
    async (call: FunctionCall) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const signal = ac.signal;

      try {
        if (call.name === "show_finding" || call.name === "next_in_tour") {
          let finding: Finding | undefined;
          if (call.name === "next_in_tour") {
            tourIndexRef.current = Math.min(
              tourIndexRef.current + 1,
              orderedFindings.length - 1
            );
            finding = orderedFindings[tourIndexRef.current];
          } else {
            finding = findingById(String(call.args.findingId));
            tourIndexRef.current = orderedFindings.findIndex((f) => f.id === finding?.id);
          }
          if (!finding) return;

          setMarkerVisible(false);
          setMarker(null);
          if (finding.track && finding.track.length > 1) {
            // Replay the recorded dynamic flow (scroll/window/zoom over time).
            await runTrack(caseData.pacsbinBaseUrl, finding.track, apply, PLAYBACK_CHROME, {
              signal,
            });
          } else {
            // Single-shot finding: synthesise a clean transition to it.
            await runTransition(
              caseData.pacsbinBaseUrl,
              currentViewportRef.current,
              finding.viewport,
              apply,
              PLAYBACK_CHROME,
              { signal }
            );
          }
          currentViewportRef.current =
            finding.track?.[finding.track.length - 1]?.viewport ?? finding.viewport;
          // Fade in the marker after the transition settles.
          setMarker(finding.marker);
          setMarkerVisible(true);
          setActiveFindingId(finding.id);
        } else if (call.name === "set_window") {
          const ww = Number(call.args.ww);
          const wc = Number(call.args.wc);
          const cur = currentViewportRef.current;
          await animateWindow(
            viewerRef.current?.getSrc() ?? initialSrc,
            cur.ww1 ?? ww,
            cur.wc1 ?? wc,
            ww,
            wc,
            apply,
            { signal }
          );
          currentViewportRef.current = { ...cur, ww1: ww, wc1: wc };
        } else if (call.name === "compare") {
          const a = findingById(String(call.args.findingIdA));
          const b = findingById(String(call.args.findingIdB));
          if (!a || !b) return;
          const compareVp: Viewport = {
            ...a.viewport,
            layout: "2x1",
            s2: b.viewport.s1,
            i2: b.viewport.i1,
            ww2: b.viewport.ww1,
            wc2: b.viewport.wc1,
            scale2: b.viewport.scale1,
            translation2: b.viewport.translation1,
          };
          apply(buildViewerUrl(caseData.pacsbinBaseUrl, compareVp, PLAYBACK_CHROME));
          currentViewportRef.current = compareVp;
          setMarker(a.marker);
          setMarkerVisible(true);
          setActiveFindingId(a.id);
        }
      } catch (e) {
        // AbortError is expected when a new transition supersedes this one.
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          console.error(e);
        }
      }
    },
    [apply, caseData, findingById, initialSrc, orderedFindings]
  );

  // Send a turn to the tutor and apply its response. `audio` carries a spoken
  // question (Gemini does STT); the matching user message text may be a stub.
  const sendTurn = useCallback(
    async (history: ChatMessage[], audio?: { base64: string; mime: string }) => {
      setBusy(true);
      try {
        const res = await fetch("/api/tutor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseId: caseData.caseId, mode, messages: history, audio }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Tutor error");

        // Execute tool calls in sequence, then narrate.
        for (const call of (data.functionCalls ?? []) as FunctionCall[]) {
          await executeCall(call);
        }

        if (data.text) {
          setMessages((m) => [...m, { role: "assistant", text: data.text }]);
          speak(data.text);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Tutor error";
        setMessages((m) => [...m, { role: "assistant", text: `⚠️ ${msg}` }]);
      } finally {
        setBusy(false);
      }
    },
    [caseData.caseId, mode, executeCall]
  );

  function start() {
    setStarted(true);
    sendTurn([]);
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    stopSpeaking(); // barge-in: cut narration when the student speaks/types
    const next: ChatMessage[] = [...messages, { role: "user", text: trimmed }];
    setMessages(next);
    setInput("");
    sendTurn(next);
  }

  // Push-to-talk: toggle recording. Starting cuts narration (barge-in);
  // stopping sends the audio to the tutor (Gemini transcribes + answers).
  async function toggleVoice() {
    if (recorder.recording) {
      const rec = await recorder.stop();
      if (!rec || busy) return;
      const next: ChatMessage[] = [...messages, { role: "user", text: "🎙 (voice question)" }];
      setMessages(next);
      sendTurn(next, { base64: rec.base64, mime: rec.mimeType });
    } else {
      stopSpeaking();
      await recorder.start();
    }
  }

  // Stop speech + animations when leaving.
  useEffect(() => () => {
    stopSpeaking();
    abortRef.current?.abort();
  }, []);

  return (
    <div className="grid grid-cols-[1fr_380px] h-[calc(100vh-49px)]">
      <ViewerFrame
        ref={viewerRef}
        initialSrc={initialSrc}
        marker={marker}
        markerVisible={markerVisible}
        className="h-full w-full"
      />

      <aside className="flex flex-col border-l border-neutral-800">
        <div className="border-b border-neutral-800 p-3">
          <h2 className="font-semibold text-sm">{caseData.title}</h2>
          <div className="mt-2 flex gap-1">
            {(["guided", "socratic", "free"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={started}
                className={`flex-1 rounded px-2 py-1 text-xs capitalize ${
                  mode === m
                    ? "bg-yellow-500 text-black"
                    : "border border-neutral-700 text-neutral-400"
                } disabled:opacity-50`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Findings rail: progress + per-finding Q&A. Click to ask about one. */}
        {started && (
          <div className="border-b border-neutral-800 px-3 py-2">
            <div className="flex flex-wrap gap-1">
              {orderedFindings.map((f, i) => (
                <button
                  key={f.id}
                  onClick={() => send(`Tell me about ${f.label}.`)}
                  disabled={busy}
                  title={f.label}
                  className={`max-w-[160px] truncate rounded px-2 py-1 text-[11px] disabled:opacity-50 ${
                    activeFindingId === f.id
                      ? "bg-yellow-500 text-black"
                      : "border border-neutral-700 text-neutral-300 hover:border-neutral-500"
                  }`}
                >
                  {i + 1}. {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {!started ? (
            <div className="text-center py-8">
              <p className="text-sm text-neutral-400 mb-4">
                Mode: <span className="capitalize text-neutral-200">{mode}</span>
              </p>
              <button onClick={start} className="btn-primary text-sm">
                Start session
              </button>
            </div>
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                className={`text-sm ${m.role === "user" ? "text-right" : ""}`}
              >
                <span
                  className={`inline-block rounded-lg px-3 py-2 ${
                    m.role === "user"
                      ? "bg-neutral-800"
                      : "bg-neutral-900 border border-neutral-800"
                  }`}
                >
                  {m.text}
                </span>
              </div>
            ))
          )}
          {busy && <div className="text-xs text-neutral-500">tutor is thinking…</div>}
        </div>

        {started && (
          <div className="border-t border-neutral-800 p-3 space-y-2">
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="Ask the tutor, or say 'next'…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send(input)}
              />
              <button onClick={() => send(input)} disabled={busy} className="btn-primary text-sm">
                Send
              </button>
            </div>
            <div className="flex gap-2">
              {mode === "guided" && (
                <button onClick={() => send("next")} disabled={busy} className="btn-secondary flex-1 text-sm">
                  Next finding →
                </button>
              )}
              {recorder.supported && (
                <button
                  onClick={toggleVoice}
                  disabled={busy && !recorder.recording}
                  className={`flex-1 text-sm ${recorder.recording ? "btn-recording" : "btn-secondary"}`}
                >
                  {recorder.recording ? "● Stop & ask" : "🎙 Ask by voice"}
                </button>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function firstOrEmpty(c: CaseData): Viewport {
  const ordered = c.findings.slice().sort((a, b) => a.order - b.order);
  return ordered[0]?.viewport ?? { layout: "1x1", s1: "", i1: "" };
}
