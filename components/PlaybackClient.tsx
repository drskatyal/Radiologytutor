"use client";

// /case/[caseId] playback (Pacsbin 2.0). Clean embed + animated marker overlay
// + AI tutor chat. The tutor emits function calls; we execute them by snapping
// the iframe to recorded `state` blobs (single view or a keyframe flow).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ViewerFrame, { type ViewerFrameHandle } from "@/components/ViewerFrame";
import { useRecorder } from "@/components/useRecorder";
import { speak, stopSpeaking } from "@/lib/speak";
import { buildViewerUrl, PLAYBACK_CHROME } from "@/lib/pacsbinUrl";
import { showState, playKeyframes } from "@/lib/viewerController";
import type { CaseData, Finding, Marker } from "@/lib/types";

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

  const tourIndexRef = useRef<number>(-1);
  const recorder = useRecorder();

  const orderedFindings = useMemo(
    () => caseData.findings.slice().sort((a, b) => a.order - b.order),
    [caseData]
  );

  const initialSrc = useMemo(
    () => buildViewerUrl(caseData.pacsbinBaseUrl, orderedFindings[0]?.state ?? "", PLAYBACK_CHROME),
    [caseData, orderedFindings]
  );

  const apply = useCallback((url: string) => viewerRef.current?.setSrc(url), []);
  const findingById = useCallback(
    (id: string) => caseData.findings.find((f) => f.id === id),
    [caseData]
  );

  // Reveal a finding: snap to its state (or replay its keyframe flow), then
  // fade in the marker.
  const revealFinding = useCallback(
    async (finding: Finding, signal: AbortSignal) => {
      setMarkerVisible(false);
      setMarker(null);
      if (finding.keyframes && finding.keyframes.length > 1) {
        await playKeyframes(caseData.pacsbinBaseUrl, finding.keyframes, apply, PLAYBACK_CHROME, {
          signal,
          onKeyframe: (i) => {
            const m = finding.keyframes![i].marker;
            if (m) {
              setMarker(m);
              setMarkerVisible(true);
            }
          },
        });
      } else {
        showState(caseData.pacsbinBaseUrl, finding.state, apply, PLAYBACK_CHROME);
      }
      setMarker(finding.marker);
      setMarkerVisible(true);
      setActiveFindingId(finding.id);
    },
    [apply, caseData.pacsbinBaseUrl]
  );

  const executeCall = useCallback(
    async (call: FunctionCall) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        let finding: Finding | undefined;
        if (call.name === "next_in_tour") {
          tourIndexRef.current = Math.min(tourIndexRef.current + 1, orderedFindings.length - 1);
          finding = orderedFindings[tourIndexRef.current];
        } else if (call.name === "show_finding") {
          finding = findingById(String(call.args.findingId));
          tourIndexRef.current = orderedFindings.findIndex((f) => f.id === finding?.id);
        }
        if (finding) await revealFinding(finding, ac.signal);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) console.error(e);
      }
    },
    [findingById, orderedFindings, revealFinding]
  );

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
        for (const call of (data.functionCalls ?? []) as FunctionCall[]) {
          await executeCall(call);
        }
        if (data.text) {
          setMessages((m) => [...m, { role: "assistant", text: data.text }]);
          speak(data.text);
        }
      } catch (e) {
        setMessages((m) => [...m, { role: "assistant", text: `⚠️ ${e instanceof Error ? e.message : "Tutor error"}` }]);
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
    stopSpeaking();
    const next: ChatMessage[] = [...messages, { role: "user", text: trimmed }];
    setMessages(next);
    setInput("");
    sendTurn(next);
  }

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

  useEffect(
    () => () => {
      stopSpeaking();
      abortRef.current?.abort();
    },
    []
  );

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
                  mode === m ? "bg-yellow-500 text-black" : "border border-neutral-700 text-neutral-400"
                } disabled:opacity-50`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

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
              <button onClick={start} className="btn-primary text-sm">Start session</button>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`text-sm ${m.role === "user" ? "text-right" : ""}`}>
                <span
                  className={`inline-block rounded-lg px-3 py-2 ${
                    m.role === "user" ? "bg-neutral-800" : "bg-neutral-900 border border-neutral-800"
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
              <button onClick={() => send(input)} disabled={busy} className="btn-primary text-sm">Send</button>
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
