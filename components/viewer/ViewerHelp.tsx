"use client";

// The viewer's shortcut sheet. Opened from the toolbar's keyboard button, H,
// or `?` where the viewer owns it. Drawn inside the imaging pane (not a body
// portal) so it survives fullscreen and covers only the image it describes.

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/components/ui/cn";
import {
  VIEWER_POINTER_HINTS,
  VIEWER_SHORTCUT_GROUPS,
  type ShortcutRow,
} from "@/lib/viewerHotkeys";

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="min-w-[1.5rem] rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-center font-sans text-[11px] font-medium leading-4 text-white/85"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Row({ row }: { row: ShortcutRow }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-white/75">{row.does}</span>
      <Keys keys={row.keys} />
    </li>
  );
}

export function ViewerHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-3 backdrop-blur-[2px] animate-overlay-in"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "h" || event.key === "H" || event.key === "?") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        className="max-h-full w-full max-w-2xl overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-[#181818] p-4 text-white shadow-2xl sm:p-5"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-sm font-semibold tracking-tight">
            Viewer shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close shortcuts"
            onClick={onClose}
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-md text-white/70",
              "transition-[transform,background-color] duration-75 hover:bg-white/10 hover:text-white active:scale-[0.92]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            )}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mb-4 text-xs text-white/55">
          Click the image first — keys act on the viewport you are in.
        </p>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {VIEWER_SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/45">
                {group.title}
              </h3>
              <ul className="divide-y divide-white/5">
                {group.rows.map((row) => (
                  <Row key={row.does} row={row} />
                ))}
              </ul>
            </section>
          ))}
          <section className="sm:col-span-2">
            <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/45">
              Mouse &amp; touch
            </h3>
            <ul className="grid gap-x-8 divide-white/5 sm:grid-cols-2">
              {VIEWER_POINTER_HINTS.map((row) => (
                <Row key={row.keys.join()} row={row} />
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
