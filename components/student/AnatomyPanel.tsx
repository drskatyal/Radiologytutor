"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { IconButton, Spinner } from "@/components/ui";
import {
  ANATOMY_DISCLAIMER,
  GENERIC_STRUCTURES,
  type AnatomyManifest,
} from "@/lib/anatomyCatalog";

const AnatomyStage = dynamic(() => import("./AnatomyStage"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-32 items-center justify-center gap-2 bg-black text-sm text-white">
      <Spinner size="sm" label="Loading 3D anatomy" />
      Loading 3D anatomy…
    </div>
  ),
});

const GENERIC_MANIFEST: AnatomyManifest = {
  source: "generic-schematic",
  glb: "/anatomy/generic-schematic.glb",
  disclaimer: ANATOMY_DISCLAIMER,
  structures: GENERIC_STRUCTURES.map((item) => ({ ...item })),
  findings: [],
};

export function AnatomyPanel({
  caseId,
  findingId,
  sliceImage,
  onClose,
}: {
  caseId?: string;
  findingId?: string;
  sliceImage?: string | null;
  onClose: () => void;
}) {
  const [manifest, setManifest] = useState<AnatomyManifest | null>(null);
  const [selected, setSelected] = useState("right-lung");
  const [exploded, setExploded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/anatomy/lidc-organs.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: AnatomyManifest | null) => {
        if (cancelled) return;
        if (data && data.source === "totalsegmentator" && (!caseId || data.caseId === caseId)) {
          setManifest(data);
          setSelected(data.structures[0]?.id ?? "right-lung");
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

  const view = manifest ? { ...manifest, activeFindingId: findingId } : null;
  const current = view?.structures.find((item) => item.id === selected);

  return (
    <div
      className="absolute z-30 flex min-h-0 flex-col border-[#1F1F1F] bg-black shadow-[0_18px_50px_rgba(0,0,0,0.55)] max-lg:inset-x-0 max-lg:bottom-0 max-lg:h-[min(48dvh,440px)] max-lg:rounded-t-2xl max-lg:border-t lg:inset-y-0 lg:right-0 lg:w-[min(440px,42%)] lg:border-l"
      role="dialog"
      aria-label="3D anatomy"
      data-testid="anatomy-panel"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="font-hand text-lg leading-none tracking-tight text-[#FFE14A]">
            {view?.source === "totalsegmentator" ? "This study, in 3D" : "Schematic anatomy"}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-white/70" data-testid="anatomy-disclaimer">
            {view?.disclaimer ?? "Loading organ meshes…"}
          </p>
        </div>
        <IconButton aria-label="Close 3D anatomy" variant="secondary" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-2">
        {view?.structures.map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              item.id === selected
                ? "shrink-0 rounded-full bg-[#FFE14A] px-2.5 py-1 font-hand text-[13px] tracking-tight text-[#1a1408]"
                : "shrink-0 rounded-full bg-white/5 px-2.5 py-1 font-hand text-[13px] tracking-tight text-[#f6efe2] ring-1 ring-white/15"
            }
            onClick={() => setSelected(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
        <div className="flex shrink-0 items-center justify-between px-3 pb-1">
          {current ? <p className="font-hand text-sm text-[#3EE0FF]">Flying to {current.label}</p> : <span />}
          <button
            type="button"
            className="rounded-full bg-white/5 px-2.5 py-1 font-hand text-[13px] tracking-tight text-[#f6efe2] ring-1 ring-white/15"
            onClick={() => setExploded((value) => !value)}
          >
            {exploded ? "Assemble" : "Exploded view"}
          </button>
        </div>
      <div className="relative min-h-0 flex-1">
        {view ? (
          <AnatomyStage
            manifest={view}
            selected={selected}
            onSelect={setSelected}
            exploded={exploded}
            sliceImage={sliceImage}
          />
        ) : null}
      </div>
    </div>
  );
}
