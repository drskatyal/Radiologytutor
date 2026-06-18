"use client";

// /author — tutor flow (Pacsbin 2.0).
// 1. Add case: paste the (shared) Pacsbin viewer URL / case link.
// 2. Add findings:
//    a. Navigate in Pacsbin, copy its URL, paste here -> we keep the encoded
//       `state` blob (slice/window/zoom/pan/plane/layout — everything).
//       Capture multiple for a dynamic flow (each = a timestamped keyframe).
//    b. Click the spot on the overlay -> marker (stored as percentages).
//    c. Dictate -> Gemini structures { label, description, teachingPoints }.
//    d. Save.

import { useRef, useState } from "react";
import ViewerFrame, { type ViewerFrameHandle } from "@/components/ViewerFrame";
import { useRecorder } from "@/components/useRecorder";
import {
  extractState,
  parseBaseUrl,
  buildViewerUrl,
  decodeState,
  summarizeState,
  AUTHOR_CHROME,
} from "@/lib/pacsbinUrl";
import type { CaseData, Finding, Keyframe, Marker } from "@/lib/types";

export default function AuthorPage() {
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  if (!caseData) return <AttachCase onAttached={setCaseData} />;
  return <AuthorWorkspace caseData={caseData} setCaseData={setCaseData} />;
}

// ---------------------------------------------------------------------------

function AttachCase({ onAttached }: { onAttached: (c: CaseData) => void }) {
  const [caseId, setCaseId] = useState("");
  const [title, setTitle] = useState("");
  const [modality, setModality] = useState("MR");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    if (!caseId || !title || !url) return setError("Case id, title and Pacsbin URL are required.");
    setBusy(true);
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, title, modality, pacsbinBaseUrl: url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create case");
      onAttached(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold mb-1">Add a case</h1>
      <p className="text-neutral-400 mb-6 text-sm">
        Paste the <b>shared</b> Pacsbin viewer link for the study (a public/share
        link loads without login). Use the case header tools to navigate while authoring.
      </p>
      <div className="space-y-3">
        <Field label="Case id (filename)">
          <input className="input" placeholder="knee-acl-01" value={caseId} onChange={(e) => setCaseId(e.target.value)} />
        </Field>
        <Field label="Title">
          <input className="input" placeholder="Knee MRI — ACL tear" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Modality">
          <input className="input" value={modality} onChange={(e) => setModality(e.target.value)} />
        </Field>
        <Field label="Pacsbin shared viewer URL">
          <input className="input" placeholder="https://pacsbin.com/viewer/case/<id>" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button onClick={submit} disabled={busy} className="btn-primary w-full">
          {busy ? "Adding…" : "Add case"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AuthorWorkspace({
  caseData,
  setCaseData,
}: {
  caseData: CaseData;
  setCaseData: (c: CaseData) => void;
}) {
  const viewerRef = useRef<ViewerFrameHandle>(null);

  // Draft finding being authored.
  const [pastedUrl, setPastedUrl] = useState("");
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [summary, setSummary] = useState("");
  const [marker, setMarker] = useState<Marker | null>(null);
  const [placingMarker, setPlacingMarker] = useState(false);
  const [structured, setStructured] = useState<{
    label: string;
    description: string;
    teachingPoints: string[];
  } | null>(null);
  const [structuring, setStructuring] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [saveError, setSaveError] = useState("");
  const recStartRef = useRef<number>(0);

  const recorder = useRecorder();

  const initialSrc = buildViewerUrl(
    caseData.pacsbinBaseUrl,
    caseData.findings[0]?.state ?? "",
    AUTHOR_CHROME
  );

  // Capture the current Pacsbin view as a keyframe from the pasted URL.
  async function captureKeyframe() {
    setSaveError("");
    const state = extractState(pastedUrl.trim());
    if (!state) return setSaveError("That URL has no Pacsbin `state` — copy the viewer URL after navigating.");

    const now = Date.now();
    if (keyframes.length === 0) recStartRef.current = now;
    const t = now - recStartRef.current;
    setKeyframes((k) => [...k, { t, state }]);
    setPastedUrl("");

    // Jump the author embed to this exact view so the marker lands correctly.
    viewerRef.current?.setSrc(buildViewerUrl(caseData.pacsbinBaseUrl, state, AUTHOR_CHROME));

    // Best-effort decoded summary.
    try {
      setSummary(summarizeState(await decodeState(state)));
    } catch {
      setSummary("(state captured; could not decode summary)");
    }
  }

  async function structure(audio?: { base64: string; mimeType: string }) {
    if (!audio && !transcript.trim()) return;
    setStructuring(true);
    setSaveError("");
    try {
      const res = await fetch("/api/structure-finding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: transcript.trim() || undefined,
          audioBase64: audio?.base64,
          audioMime: audio?.mimeType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to structure");
      setStructured(data);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed");
    } finally {
      setStructuring(false);
    }
  }

  async function toggleDictation() {
    if (recorder.recording) {
      const rec = await recorder.stop();
      if (rec) await structure({ base64: rec.base64, mimeType: rec.mimeType });
    } else {
      await recorder.start();
    }
  }

  async function saveFinding() {
    setSaveError("");
    if (keyframes.length === 0) return setSaveError("Capture at least one Pacsbin view first.");
    if (!marker) return setSaveError("Click on the image to place a marker.");
    if (!structured) return setSaveError("Dictate and structure the finding first.");

    const hasFlow = keyframes.length > 1;
    const finding: Partial<Finding> = {
      label: structured.label,
      description: structured.description,
      teachingPoints: structured.teachingPoints,
      state: keyframes[0].state,
      marker,
      keyframes: hasFlow ? keyframes : undefined,
      durationMs: hasFlow ? keyframes[keyframes.length - 1].t : undefined,
      order: caseData.findings.length + 1,
    };
    const res = await fetch(`/api/cases/${caseData.caseId}/findings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(finding),
    });
    const data = await res.json();
    if (!res.ok) return setSaveError(data.error || "Failed to save");
    setCaseData(data);
    resetDraft();
  }

  function resetDraft() {
    setPastedUrl("");
    setKeyframes([]);
    setSummary("");
    setMarker(null);
    setPlacingMarker(false);
    setStructured(null);
    setTranscript("");
  }

  async function removeFinding(id: string) {
    const res = await fetch(`/api/cases/${caseData.caseId}/findings/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) setCaseData(data);
  }

  async function move(id: string, dir: -1 | 1) {
    const ids = caseData.findings.map((f) => f.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const res = await fetch(`/api/cases/${caseData.caseId}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds: ids }),
    });
    const data = await res.json();
    if (res.ok) setCaseData(data);
  }

  return (
    <div className="grid grid-cols-[1fr_380px] h-[calc(100vh-49px)]">
      <div className="relative">
        <ViewerFrame
          ref={viewerRef}
          initialSrc={initialSrc}
          marker={marker}
          markerVisible
          onOverlayClick={
            placingMarker
              ? (x, y) => {
                  setMarker({ x_pct: x, y_pct: y, shape: "circle" });
                  setPlacingMarker(false);
                }
              : undefined
          }
          className="h-full w-full"
        />
        {placingMarker && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded bg-yellow-500 px-3 py-1 text-sm font-medium text-black">
            Click the finding location on the image
          </div>
        )}
      </div>

      <aside className="border-l border-neutral-800 overflow-y-auto p-4 space-y-5">
        <div>
          <h2 className="font-semibold">{caseData.title}</h2>
          <p className="text-xs text-neutral-500">{caseData.caseId}</p>
        </div>

        <section className="space-y-3 rounded-lg border border-neutral-800 p-3">
          <h3 className="text-sm font-semibold text-yellow-400">
            Add finding {keyframes.length > 1 ? "(flow)" : keyframes.length === 1 ? "(static)" : ""}
          </h3>

          {/* Step 1: capture view(s) */}
          <div>
            <label className="label">1. Capture Pacsbin view(s)</label>
            <textarea
              className="input h-16 text-xs"
              placeholder="Paste the Pacsbin viewer URL after navigating to the finding…"
              value={pastedUrl}
              onChange={(e) => setPastedUrl(e.target.value)}
            />
            <button onClick={captureKeyframe} className="btn-secondary mt-1 w-full text-sm">
              + Capture view {keyframes.length > 0 ? `(${keyframes.length} so far)` : ""}
            </button>
            {summary && <p className="mt-1 text-[11px] text-neutral-400">{summary}</p>}
            {keyframes.length > 1 && (
              <p className="text-[11px] text-neutral-500">
                {keyframes.length} keyframes over {(keyframes[keyframes.length - 1].t / 1000).toFixed(1)}s — playback snaps through them.
              </p>
            )}
          </div>

          {/* Step 2: marker */}
          <div>
            <label className="label">2. Place marker</label>
            <button onClick={() => setPlacingMarker(true)} className="btn-secondary w-full text-sm">
              {marker
                ? `Marker at ${(marker.x_pct * 100).toFixed(0)}%, ${(marker.y_pct * 100).toFixed(0)}% — click to replace`
                : "Click to place marker"}
            </button>
          </div>

          {/* Step 3: dictate */}
          <div>
            <label className="label">3. Dictate finding</label>
            {recorder.supported ? (
              <button
                onClick={toggleDictation}
                disabled={structuring}
                className={`w-full text-sm ${recorder.recording ? "btn-recording" : "btn-secondary"}`}
              >
                {recorder.recording ? "● Stop & transcribe" : "🎙 Dictate (AI transcribes)"}
              </button>
            ) : (
              <p className="text-xs text-neutral-500">Mic not available — type below.</p>
            )}
            <textarea
              className="input mt-2 h-20 text-xs"
              placeholder="e.g. Sagittal, ACL tear at the femoral attachment, complete fibre discontinuity, teaching point empty notch sign."
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
            <button
              onClick={() => structure()}
              disabled={structuring || !transcript.trim()}
              className="btn-secondary mt-1 w-full text-sm"
            >
              {structuring ? "Structuring…" : "Structure typed text with AI"}
            </button>
          </div>

          {structured && (
            <div className="rounded bg-neutral-900 p-2 text-xs space-y-1">
              <div><span className="text-neutral-500">Label:</span> {structured.label}</div>
              <div><span className="text-neutral-500">Description:</span> {structured.description}</div>
              {structured.teachingPoints.length > 0 && (
                <div><span className="text-neutral-500">Teaching:</span> {structured.teachingPoints.join("; ")}</div>
              )}
            </div>
          )}

          {saveError && <p className="text-red-400 text-xs">{saveError}</p>}
          <div className="flex gap-2">
            <button onClick={saveFinding} className="btn-primary flex-1 text-sm">Save finding</button>
            <button onClick={resetDraft} className="btn-secondary text-sm">Clear</button>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold mb-2">Findings ({caseData.findings.length})</h3>
          <ol className="space-y-2">
            {caseData.findings.map((f, i) => (
              <li key={f.id} className="rounded border border-neutral-800 p-2 text-sm flex items-start gap-2">
                <span className="text-neutral-500 w-5 shrink-0">{i + 1}.</span>
                <div className="flex-1">
                  <div className="font-medium">
                    {f.label}
                    {f.keyframes && f.keyframes.length > 1 && (
                      <span className="ml-1 text-[10px] text-sky-400">flow·{f.keyframes.length}</span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-400">{f.description}</div>
                </div>
                <div className="flex flex-col gap-1">
                  <button onClick={() => move(f.id, -1)} className="icon-btn" title="Up">↑</button>
                  <button onClick={() => move(f.id, 1)} className="icon-btn" title="Down">↓</button>
                  <button onClick={() => removeFinding(f.id)} className="icon-btn text-red-400" title="Delete">✕</button>
                </div>
              </li>
            ))}
          </ol>
          {caseData.findings.length > 0 && (
            <a href={`/case/${caseData.caseId}`} className="btn-primary mt-4 block text-center text-sm">
              Open student playback →
            </a>
          )}
        </section>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
