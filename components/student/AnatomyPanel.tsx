"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { X } from "lucide-react";
import { Button, IconButton, Spinner } from "@/components/ui";
import { ANATOMY_DISCLAIMER, GENERIC_STRUCTURES } from "@/lib/anatomyCatalog";

const AnatomyStage = dynamic(() => import("./AnatomyStage"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 bg-imaging text-sm text-white">
      <Spinner size="sm" label="Loading 3D anatomy" />
      Loading 3D anatomy…
    </div>
  ),
});

export function AnatomyPanel({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState("right-lung");
  const current = GENERIC_STRUCTURES.find((item) => item.id === selected);

  return (
    <div
      className="absolute inset-0 z-30 flex min-h-0 flex-col bg-imaging"
      role="dialog"
      aria-label="Schematic anatomy"
      data-testid="anatomy-panel"
    >
      <div className="shrink-0 border-b border-[#1F1F1F] bg-[#181818] px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-hand text-xl leading-none text-[#FFE14A]">Schematic anatomy</p>
            <p className="mt-1 max-w-xl text-xs leading-snug text-white/75" data-testid="anatomy-disclaimer">
              {ANATOMY_DISCLAIMER}
            </p>
          </div>
          <IconButton aria-label="Close 3D anatomy" variant="secondary" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {GENERIC_STRUCTURES.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={item.id === selected ? "primary" : "secondary"}
              onClick={() => setSelected(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {current && (
          <p className="mt-2 font-hand text-sm text-[#3EE0FF]">Flying to {current.label}</p>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <AnatomyStage selected={selected} onSelect={setSelected} />
      </div>
    </div>
  );
}
