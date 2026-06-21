"use client";

// Spike page for the self-hosted Cornerstone3D viewer (Option C).
// Demonstrates the "Pacsbin ⇄ Our Viewer" toggle and proves our own viewer
// renders a real DICOM study end-to-end. The Cornerstone side currently loads
// a public demo CT; once Orthanc + per-case DICOM UIDs land, both sides show
// the SAME case for a true side-by-side comparison.

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  BUNDLED_CASE,
  PUBLIC_DEMO,
  type ViewerSource,
} from "../../lib/viewerSource";
import { PageContainer, Spinner, Tabs } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { cn } from "@/components/ui/cn";

const CornerstoneViewer = dynamic(
  () => import("../../components/CornerstoneViewer"),
  {
    ssr: false,
    loading: () => (
      <div className="flex aspect-square w-full items-center justify-center rounded-xl bg-imaging text-muted">
        <span className="flex items-center gap-2 text-sm">
          <Spinner size="sm" label="Loading viewer" />
          Loading viewer…
        </span>
      </div>
    ),
  }
);

const PACSBIN_DEMO =
  "https://pacsbin.com/viewer/case/WJUZ1VRmoL?header=false&caseData=false&an=false&overlay=false&title=false";

type Mode = "pacsbin" | "cornerstone";

export default function CornerstoneSpikePage() {
  const [mode, setMode] = useState<Mode>("cornerstone");
  const [source, setSource] = useState<ViewerSource>(BUNDLED_CASE);

  // If opened with ?study=&series= (e.g. from the upload page), load that
  // uploaded study from Orthanc via the same-origin DICOMweb proxy.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const study = p.get("study");
    const series = p.get("series");
    if (study && series) {
      setSource({
        kind: "wadors",
        wadoRsRoot: p.get("root") || "/api/dicomweb",
        StudyInstanceUID: study,
        SeriesInstanceUID: series,
      });
      setMode("cornerstone");
    }
  }, []);

  const sourceIsBundled = source === BUNDLED_CASE;
  const sourceIsPublic = source === PUBLIC_DEMO;

  return (
    <>
      <PageHeader
        breadcrumbs={<span>Developer · Viewer lab</span>}
        title="Viewer comparison"
        description="Toggle between the embedded Pacsbin viewer and our self-hosted Cornerstone3D viewer. An internal sandbox for the imaging stack."
        actions={
          <Tabs
            items={[
              { value: "cornerstone", label: "Our Viewer" },
              { value: "pacsbin", label: "Pacsbin" },
            ]}
            value={mode}
            onValueChange={(v) => setMode(v as Mode)}
          />
        }
      />

      <PageContainer width="narrow">
        {mode === "pacsbin" ? (
          <iframe
            src={PACSBIN_DEMO}
            title="Pacsbin viewer"
            className="aspect-square w-full rounded-xl border border-subtle bg-imaging"
            allow="fullscreen"
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted">Source</span>
              <SourceChip
                active={sourceIsBundled}
                onClick={() => setSource(BUNDLED_CASE)}
              >
                Bundled MR (offline)
              </SourceChip>
              <SourceChip
                active={sourceIsPublic}
                onClick={() => setSource(PUBLIC_DEMO)}
              >
                Public CT (DICOMweb)
              </SourceChip>
            </div>
            <CornerstoneViewer source={source} />
          </div>
        )}
      </PageContainer>
    </>
  );
}

function SourceChip({
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
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        active
          ? "border-accent/40 bg-accent/15 text-accent"
          : "border-strong text-secondary hover:border-strong hover:text-primary"
      )}
    >
      {children}
    </button>
  );
}
