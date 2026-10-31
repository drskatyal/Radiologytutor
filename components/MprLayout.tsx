"use client";

// Three orthographic planes. Rendered only after the user chooses MPR.
// Until the volume is live the grid keeps its layout size (so Cornerstone
// can attach viewports) but does not take pointer events, and the stack
// underneath stays usable when reconstruction isn't possible.

import { useRef, type RefObject } from "react";
import { Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";

function Plane({
  label,
  nodeRef,
  tool,
}: {
  label: string;
  nodeRef: RefObject<HTMLDivElement>;
  tool: string;
}) {
  return (
    <div className="relative min-h-0 min-w-0 bg-imaging">
      <div
        ref={nodeRef}
        data-viewer-tool={tool}
        className="absolute inset-0"
        role="img"
        aria-label={`${label} plane`}
        onContextMenu={(event) => event.preventDefault()}
      />
      <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/85">
        {label}
      </span>
    </div>
  );
}

export function MprLayout({
  axialRef,
  coronalRef,
  sagittalRef,
  tool,
  live,
  loading,
  notice,
  framed = false,
}: {
  axialRef: RefObject<HTMLDivElement>;
  coronalRef: RefObject<HTMLDivElement>;
  sagittalRef: RefObject<HTMLDivElement>;
  /** Active left-button tool. Scroll and window/level drop the library crosshair. */
  tool: string;
  /** False while the volume is still mounting — the grid keeps its size so the viewports can render. */
  live: boolean;
  loading: boolean;
  notice: string | null;
  /** Docked stack chrome (radius + border) moves here once the planes are live. */
  framed?: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-[1]",
        !live && "pointer-events-none",
        framed && "overflow-hidden rounded-xl border border-subtle"
      )}
      data-mpr-layout={live ? "live" : "pending"}
    >
      <div
        className={cn(
          "grid h-full w-full grid-cols-1 grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)] gap-px bg-white/15",
          !live && "invisible"
        )}
      >
        <Plane label="Axial" nodeRef={axialRef} tool={tool} />
        <div className="grid min-h-0 grid-cols-2 gap-px">
          <Plane label="Coronal" nodeRef={coronalRef} tool={tool} />
          <Plane label="Sagittal" nodeRef={sagittalRef} tool={tool} />
        </div>
      </div>
      {loading && (
        <div className="pointer-events-auto absolute inset-0 z-[2] flex items-center justify-center bg-black/70">
          <span className="flex items-center gap-2 rounded-md bg-black/80 px-3 py-1.5 text-xs text-white ring-1 ring-white/15">
            <Spinner size="sm" label="Loading volume" className="text-white" />
            Loading volume…
          </span>
        </div>
      )}
      {notice && !live && (
        <p
          role="status"
          className="absolute inset-x-3 bottom-3 z-[2] rounded-lg bg-black/80 px-3 py-2 text-xs leading-relaxed text-white ring-1 ring-white/15"
        >
          {notice}
        </p>
      )}
    </div>
  );
}

export function LayoutToggle({
  mode,
  ready,
  onChange,
}: {
  mode: "stack" | "mpr";
  ready: boolean;
  onChange: (mode: "stack" | "mpr") => void;
}) {
  const stackRef = useRef<HTMLButtonElement>(null);
  const mprRef = useRef<HTMLButtonElement>(null);

  const select = (next: "stack" | "mpr") => {
    if (!ready) return;
    onChange(next);
    queueMicrotask(() => {
      (next === "stack" ? stackRef : mprRef).current?.focus();
    });
  };

  return (
    <div
      role="radiogroup"
      aria-label="Viewer layout"
      className="inline-flex items-center rounded-lg border border-white/15 bg-black/40 p-0.5"
    >
      {(
        [
          ["stack", "Stack", stackRef],
          ["mpr", "MPR", mprRef],
        ] as const
      ).map(([value, label, nodeRef]) => {
        const selected = mode === value;
        return (
          <button
            key={value}
            ref={nodeRef}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={!ready}
            onClick={() => select(value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              select(value === "stack" ? "mpr" : "stack");
            }}
            className={cn(
              "min-h-11 rounded-md px-2.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
              "disabled:cursor-not-allowed disabled:opacity-40",
              selected
                ? "bg-white text-black"
                : "text-white/85 hover:bg-white/10 hover:text-white"
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
