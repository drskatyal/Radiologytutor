"use client";

// Upload a DICOM study to our own backend (Orthanc) and open it in our viewer.
// Pick a folder/files of .dcm → POST /api/upload → Orthanc stores them → we get
// back the study/series UIDs → "View" opens /cornerstone?study=&series=.
//
// De-identification is not wired yet: upload only already-anonymized studies.

import { useRef, useState } from "react";

interface SeriesOut {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  description: string;
  instances: number;
}
interface UploadResult {
  stored: number;
  series: SeriesOut[];
  errors: string[];
}

export default function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setResult(null);
    setStatus(`Uploading ${files.length} file(s)…`);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append("files", f));
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Error: ${data.error || res.status}`);
        return;
      }
      setResult(data as UploadResult);
      setStatus(`Stored ${data.stored} instance(s) in ${data.series.length} series.`);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24, color: "#e8eaed" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Upload a case</h1>
      <p style={{ fontSize: 13, color: "#9aa", marginTop: 0 }}>
        Add a DICOM study (folder or files). It&apos;s stored in our own backend and
        opens in our viewer. Upload only already-anonymized studies for now.
      </p>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleUpload(e.dataTransfer.files);
        }}
        style={{
          border: "2px dashed #345",
          borderRadius: 10,
          padding: 28,
          textAlign: "center",
          background: "#0e151f",
          marginBottom: 16,
        }}
      >
        <p style={{ margin: "0 0 12px", color: "#9aa" }}>Drag &amp; drop DICOM here, or</p>
        <button
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "none",
            background: "#2d6cdf",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          {busy ? "Uploading…" : "Choose files"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          // @ts-expect-error — non-standard but widely supported folder picker
          webkitdirectory=""
          style={{ display: "none" }}
          onChange={(e) => handleUpload(e.target.files)}
        />
      </div>

      {status && <p style={{ fontSize: 13, color: "#9aa" }}>{status}</p>}

      {result && result.series.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {result.series.map((s) => (
            <div
              key={s.seriesInstanceUID}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 14px",
                border: "1px solid #345",
                borderRadius: 8,
              }}
            >
              <div>
                <div style={{ fontSize: 14 }}>{s.description}</div>
                <div style={{ fontSize: 11, color: "#9aa" }}>{s.instances} image(s)</div>
              </div>
              <a
                href={`/cornerstone?study=${encodeURIComponent(s.studyInstanceUID)}&series=${encodeURIComponent(s.seriesInstanceUID)}`}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  background: "#2d6cdf",
                  color: "#fff",
                  textDecoration: "none",
                  fontSize: 13,
                }}
              >
                View
              </a>
            </div>
          ))}
        </div>
      )}

      {result && result.errors.length > 0 && (
        <pre style={{ fontSize: 11, color: "#e88", whiteSpace: "pre-wrap", marginTop: 12 }}>
          {result.errors.join("\n")}
        </pre>
      )}
    </main>
  );
}
