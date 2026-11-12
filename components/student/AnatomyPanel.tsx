"use client";

// Full-viewport 3D view of this study's anatomy. The organ meshes come from
// TotalSegmentator run on the same de-identified CT; the active finding is a
// glowing marker inside frosted-glass lungs. A generic schematic stands in
// (and says so) when the case has no patient meshes.

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { Button, IconButton, Spinner } from "@/components/ui";
import {
  ANATOMY_DISCLAIMER,
  GENERIC_STRUCTURES,
  markMatchesFinding,
  type AnatomyManifest,
} from "@/lib/anatomyCatalog";

const AnatomyStage = dynamic(() => import("./AnatomyStage"), {
  ssr: false,
  loading: () => <StageMessage>Loading 3D anatomy…</StageMessage>,
});

const GENERIC_MANIFEST: AnatomyManifest = {
  source: "generic-schematic",
  glb: "/anatomy/generic-schematic.glb",
  disclaimer: ANATOMY_DISCLAIMER,
  structures: GENERIC_STRUCTURES.map((item) => ({ ...item })),
  findings: [],
};

function StageMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-white/80">
      <Spinner size="sm" label="Loading 3D anatomy" />
      {children}
    </div>
  );
}

export function AnatomyPanel({
  caseId,
  findingId,
  findingLabel,
  findingAnchor,
  onClose,
}: {
  caseId?: string;
  findingId?: string;
  /** The finding's current slice and marker; the 3D mark shows only if it matches. */
  findingAnchor?: { sliceIndex?: number; marker?: { x_pct: number; y_pct: number } | null };
  /** Shown on the marker when the manifest has no label for this finding. */
  findingLabel?: string;
  onClose: () => void;
}) {
  const [manifest, setManifest] = useState<AnatomyManifest | null>(null);
  const [failed, setFailed] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/anatomy/lidc-organs.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: AnatomyManifest | null) => {
        if (cancelled) return;
        if (data && data.source === "totalsegmentator" && (!caseId || data.caseId === caseId)) {
          setManifest(data);
          return;
        }
        setManifest(GENERIC_MANIFEST);
      })
      .catch(() => {
        if (!cancelled) setManifest(GENERIC_MANIFEST);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  // A dialog: focus lands on close, Escape closes.
  useEffect(() => {
    closeRef.current?.focus();
    // Capture phase: an escape layer lower down (menus, toasts) stops the
    // event before it would bubble back to window.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const patient = manifest?.source === "totalsegmentator";
  const mark = manifest?.findings.find((item) => item.findingId === findingId);
  const markOk = mark ? markMatchesFinding(mark, findingAnchor) : false;
  const view = manifest
    ? {
        ...manifest,
        activeFindingId: findingId,
        findings: markOk ? manifest.findings : manifest.findings.filter((item) => item.findingId !== findingId),
      }
    : null;
  const finding = markOk ? mark : undefined;
  const hoveredLabel = hovered ? view?.structures.find((item) => item.id === hovered)?.label : null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      role="dialog"
      aria-modal="true"
      aria-label="3D anatomy"
      data-testid="anatomy-panel"
    >
      <div className="absolute inset-0">
        {failed ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/80">
            3D view needs WebGL, which this browser has turned off.
          </div>
        ) : view ? (
          <AnatomyStage
            manifest={view}
            exploded={exploded}
            resetToken={resetToken}
            findingLabel={finding?.label ?? findingLabel}
            onHover={setHovered}
            onError={() => setFailed(true)}
          />
        ) : (
          <StageMessage>Loading organ meshes…</StageMessage>
        )}
      </div>

      {/* Top: what this is, and how to leave. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 bg-gradient-to-b from-black/80 to-transparent px-4 pb-10 pt-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink">
            {patient ? "This study · 3D" : "Schematic anatomy"}
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tightest text-white sm:text-xl">
            {finding?.label ?? findingLabel ?? "Chest anatomy"}
          </h2>
          <p className="mt-1 max-w-md text-xs leading-snug text-white/60" data-testid="anatomy-disclaimer">
            {view?.disclaimer ?? "Loading organ meshes…"}
          </p>
        </div>
        <IconButton
          ref={closeRef}
          aria-label="Close 3D anatomy"
          variant="imaging"
          size="lg"
          className="pointer-events-auto h-11 w-11 shrink-0"
          onClick={onClose}
        >
          <X />
        </IconButton>
      </div>

      {/* Bottom: the two things worth doing in 3D. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 bg-gradient-to-t from-black/80 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-10 sm:px-6">
        <p className="min-h-5 text-sm text-white/75" aria-live="polite">
          {hoveredLabel ?? "Drag to turn · scroll or pinch to zoom"}
        </p>
        <div className="pointer-events-auto flex gap-2">
          <Button
            variant="imaging"
            size="sm"
            aria-pressed={exploded}
            onClick={() => setExploded((value) => !value)}
          >
            {exploded ? "Assemble" : "Exploded view"}
          </Button>
          <Button
            variant="imaging"
            size="sm"
            leadingIcon={<RotateCcw className="h-4 w-4" />}
            onClick={() => {
              setExploded(false);
              setResetToken((n) => n + 1);
            }}
          >
            Reset view
          </Button>
        </div>
      </div>
    </div>
  );
}
