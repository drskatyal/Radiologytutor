"use client";

// Spike page for the self-hosted Cornerstone3D viewer (Option C).
// Demonstrates the "Pacsbin ⇄ Our Viewer" toggle and proves our own viewer
// renders a real DICOM study end-to-end. The Cornerstone side currently loads
// a public demo CT; once Orthanc + per-case DICOM UIDs land, both sides show
// the SAME case for a true side-by-side comparison.

import { useState } from "react";
import dynamic from "next/dynamic";

const CornerstoneViewer = dynamic(
  () => import("../../components/CornerstoneViewer"),
  { ssr: false, loading: () => <p style={{ color: "#9aa" }}>Loading viewer…</p> }
);

const PACSBIN_DEMO =
  "https://pacsbin.com/viewer/case/WJUZ1VRmoL?header=false&caseData=false&an=false&overlay=false&title=false";

type Mode = "pacsbin" | "cornerstone";

export default function CornerstoneSpikePage() {
  const [mode, setMode] = useState<Mode>("cornerstone");

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24, color: "#e8eaed" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Viewer comparison</h1>
      <p style={{ fontSize: 13, color: "#9aa", marginTop: 0 }}>
        Toggle between the embedded Pacsbin viewer and our self-hosted
        Cornerstone3D viewer.
      </p>

      <div style={{ display: "inline-flex", gap: 0, marginBottom: 16, border: "1px solid #345", borderRadius: 8, overflow: "hidden" }}>
        <ToggleButton active={mode === "pacsbin"} onClick={() => setMode("pacsbin")}>
          Pacsbin
        </ToggleButton>
        <ToggleButton active={mode === "cornerstone"} onClick={() => setMode("cornerstone")}>
          Our Viewer (Cornerstone3D)
        </ToggleButton>
      </div>

      {mode === "pacsbin" ? (
        <iframe
          src={PACSBIN_DEMO}
          style={{ width: "100%", aspectRatio: "1 / 1", border: "none", background: "#000", borderRadius: 8 }}
          allow="fullscreen"
        />
      ) : (
        <CornerstoneViewer />
      )}
    </main>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 14px",
        fontSize: 13,
        border: "none",
        cursor: "pointer",
        background: active ? "#2d6cdf" : "transparent",
        color: active ? "#fff" : "#9aa",
      }}
    >
      {children}
    </button>
  );
}
