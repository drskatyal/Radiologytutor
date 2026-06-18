"use client";

// /author — tutor flow.
// 1. Attach a Pacsbin case (paste viewer URL).
// 2. Add findings: paste Pacsbin bookmark -> parse viewport (read-only confirm),
//    click overlay -> marker, dictate -> Gemini structures the text, save.
// 3. List / delete / reorder findings.

import { useRef, useState } from "react";
import ViewerFrame, { type ViewerFrameHandle } from "@/components/ViewerFrame";
import { useDictation } from "@/components/useDictation";
import {
  parseViewportFromUrl,
  parseBaseUrl,
  buildViewerUrl,
  AUTHOR_CHROME,
} from "@/lib/pacsbinUrl";
import type { CaseData, Finding, Marker, Viewport } from "@/lib/types";

export default function AuthorPage() {
  const [caseData, setCaseData] = useState<CaseData | null>(null);

  if (!caseData) {
    return <AttachCase onAttached={setCaseData} />;
  }
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
    if (!caseId || !title || !url) {
      setError("Case id, title and Pacsbin URL are required.");
      return;
    }
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
      <h1 className="text-2xl font-semibold mb-1">Attach a case</h1>
      <p className="text-neutral-400 mb-6 text-sm">
        Paste the Pacsbin viewer URL for the case. The toolbar stays on so you can
        navigate while authoring.
      </p>
      <div className="space-y-3">
        <Field label="Case id (used as filename)">
          <input
            className="input"
            placeholder="knee-acl-01"
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
          />
        </Field>
        <Field label="Title">
          <input
            className="input"
            placeholder="Knee MRI — ACL tear"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Modality">
          <input
            className="input"
            value={modality}
            onChange={(e) => setModality(e.target.value)}
          />
        </Field>
        <Field label="Pacsbin viewer URL">
          <input
            className="input"
            placeholder="https://pacsbin.com/viewer/<token>"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button onClick={submit} disabled={busy} className="btn-primary w-full">
          {busy ? "Attaching…" : "Attach case"}
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
  const [bookmarkUrl, setBookmarkUrl] = useState("");
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [marker, setMarker] = useState<Marker | null>(null);
  const [placingMarker, setPlacingMarker] = useState(false);
  const [structured, setStructured] = useState<{
    label: string;
    description: string;
    teachingPoints: string[];
  } | null>(null);
  const [structuring, setStructuring] = useState(false);
  const [saveError, setSaveError] = useState("");

  const dictation = useDictation();

  const authorSrc = buildViewerUrl(caseData.pacsbinBaseUrl, defaultViewport(caseData), AUTHOR_CHROME);

  function parseBookmark() {
    if (!bookmarkUrl.trim()) return;
    const vp = parseViewportFromUrl(bookmarkUrl);
    setViewport(vp);
    // Jump the author iframe to this exact view so the tutor can place the
    // marker on the right anatomy.
    const locked = buildViewerUrl(parseBaseUrl(bookmarkUrl) || caseData.pacsbinBaseUrl, vp, AUTHOR_CHROME);
    viewerRef.current?.setSrc(locked);
  }

  async function structure() {
    if (!dictation.transcript.trim()) return;
    setStructuring(true);
    try {
      const res = await fetch("/api/structure-finding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: dictation.transcript }),
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

  async function saveFinding() {
    setSaveError("");
    if (!viewport) return setSaveError("Paste a Pacsbin bookmark URL first.");
    if (!marker) return setSaveError("Click on the image to place a marker.");
    if (!structured) return setSaveError("Dictate and structure the finding first.");

    const finding: Partial<Finding> = {
      label: structured.label,
      description: structured.description,
      teachingPoints: structured.teachingPoints,
      viewport,
      marker,
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
    setBookmarkUrl("");
    setViewport(null);
    setMarker(null);
    setPlacingMarker(false);
    setStructured(null);
    dictation.reset();
  }

  async function removeFinding(id: string) {
    const res = await fetch(`/api/cases/${caseData.caseId}/findings/${id}`, {
      method: "DELETE",
    });
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
      {/* Viewer + overlay */}
      <div className="relative">
        <ViewerFrame
          ref={viewerRef}
          initialSrc={authorSrc}
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

      {/* Authoring panel */}
      <aside className="border-l border-neutral-800 overflow-y-auto p-4 space-y-5">
        <div>
          <h2 className="font-semibold">{caseData.title}</h2>
          <p className="text-xs text-neutral-500">{caseData.caseId}</p>
        </div>

        <section className="space-y-3 rounded-lg border border-neutral-800 p-3">
          <h3 className="text-sm font-semibold text-yellow-400">Add finding</h3>

          {/* Step a: bookmark */}
          <div>
            <label className="label">1. Paste Pacsbin bookmark URL</label>
            <textarea
              className="input h-16 text-xs"
              placeholder="Pacsbin link-to-image URL…"
              value={bookmarkUrl}
              onChange={(e) => setBookmarkUrl(e.target.value)}
            />
            <button onClick={parseBookmark} className="btn-secondary mt-1 w-full text-sm">
              Parse viewport
            </button>
            {viewport && (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-neutral-900 p-2 text-[11px] text-neutral-400">
                {JSON.stringify(viewport, null, 2)}
              </pre>
            )}
          </div>

          {/* Step b: marker */}
          <div>
            <label className="label">2. Place marker</label>
            <button
              onClick={() => setPlacingMarker(true)}
              className="btn-secondary w-full text-sm"
            >
              {marker
                ? `Marker at ${(marker.x_pct * 100).toFixed(0)}%, ${(marker.y_pct * 100).toFixed(0)}% — click to replace`
                : "Click to place marker"}
            </button>
          </div>

          {/* Step c: dictate */}
          <div>
            <label className="label">3. Dictate finding</label>
            {dictation.supported ? (
              <button
                onClick={dictation.listening ? dictation.stop : dictation.start}
                className={`w-full text-sm ${dictation.listening ? "btn-recording" : "btn-secondary"}`}
              >
                {dictation.listening ? "● Stop recording" : "🎙 Start dictation"}
              </button>
            ) : (
              <p className="text-xs text-neutral-500">
                Mic not supported in this browser — type the finding below.
              </p>
            )}
            <textarea
              className="input mt-2 h-20 text-xs"
              placeholder="e.g. Sagittal T2, ACL tear at the femoral attachment, complete fibre discontinuity, teaching point empty notch sign."
              value={dictation.transcript}
              onChange={(e) => dictation.setTranscript(e.target.value)}
            />
            <button
              onClick={structure}
              disabled={structuring}
              className="btn-secondary mt-1 w-full text-sm"
            >
              {structuring ? "Structuring…" : "Structure with AI"}
            </button>
          </div>

          {structured && (
            <div className="rounded bg-neutral-900 p-2 text-xs space-y-1">
              <div>
                <span className="text-neutral-500">Label:</span> {structured.label}
              </div>
              <div>
                <span className="text-neutral-500">Description:</span> {structured.description}
              </div>
              {structured.teachingPoints.length > 0 && (
                <div>
                  <span className="text-neutral-500">Teaching:</span>{" "}
                  {structured.teachingPoints.join("; ")}
                </div>
              )}
            </div>
          )}

          {saveError && <p className="text-red-400 text-xs">{saveError}</p>}
          <div className="flex gap-2">
            <button onClick={saveFinding} className="btn-primary flex-1 text-sm">
              Save finding
            </button>
            <button onClick={resetDraft} className="btn-secondary text-sm">
              Clear
            </button>
          </div>
        </section>

        {/* Findings list */}
        <section>
          <h3 className="text-sm font-semibold mb-2">
            Findings ({caseData.findings.length})
          </h3>
          <ol className="space-y-2">
            {caseData.findings.map((f, i) => (
              <li
                key={f.id}
                className="rounded border border-neutral-800 p-2 text-sm flex items-start gap-2"
              >
                <span className="text-neutral-500 w-5 shrink-0">{i + 1}.</span>
                <div className="flex-1">
                  <div className="font-medium">{f.label}</div>
                  <div className="text-xs text-neutral-400">{f.description}</div>
                </div>
                <div className="flex flex-col gap-1">
                  <button onClick={() => move(f.id, -1)} className="icon-btn" title="Up">
                    ↑
                  </button>
                  <button onClick={() => move(f.id, 1)} className="icon-btn" title="Down">
                    ↓
                  </button>
                  <button
                    onClick={() => removeFinding(f.id)}
                    className="icon-btn text-red-400"
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ol>
          {caseData.findings.length > 0 && (
            <a
              href={`/case/${caseData.caseId}`}
              className="btn-primary mt-4 block text-center text-sm"
            >
              Open student playback →
            </a>
          )}
        </section>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

function defaultViewport(c: CaseData): Viewport {
  // Use the first finding's series if we have one, else a bare 1x1.
  const first = c.findings[0];
  if (first) return first.viewport;
  return { layout: "1x1", s1: "", i1: "" };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
