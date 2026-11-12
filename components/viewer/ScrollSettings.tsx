"use client";

// Settings › Scrolling for the free viewer, as the desktop's Settings ›
// Scrolling: slices per wheel notch, browse-drag distance per slice, and
// acceleration for a quick run of notches. Applied live (the viewer's
// StackScroll reads them on every wheel / drag: viewer-core
// scrollSensitivity) and remembered in this browser. A strip below lets the
// reader feel the setting before going back to the image.

import { useState } from "react";
import { Slider, Switch } from "@/components/ui";
import {
  ACCELERATION_WINDOW_MS,
  createWheelScrollState,
  dragPixelsPerSlice,
  getScrollPreferences,
  slicesForNotch,
  takeWheelSlices,
  type ScrollPreferences,
} from "@flowrad/viewer-core/scrollSensitivity";
import { saveScrollPreferences } from "@/lib/scrollPreferencesStore";

export function ScrollSettings() {
  const [prefs, setPrefs] = useState<ScrollPreferences>(() => getScrollPreferences());
  const update = (next: Partial<ScrollPreferences>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    saveScrollPreferences(merged);
  };
  const dragPx = prefs.dragPixelsPerSlice ?? 0;
  return (
    <section aria-labelledby="scroll-settings-title" className="mb-5 border-b border-white/10 pb-4">
      <h3 id="scroll-settings-title" className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/45">
        Scrolling
      </h3>
      <Slider
        tone="imaging"
        label="Mouse wheel"
        min={1}
        max={10}
        value={prefs.slicesPerNotch}
        valueLabel={`${prefs.slicesPerNotch} slice${prefs.slicesPerNotch === 1 ? "" : "s"} per notch`}
        onChange={(v) => update({ slicesPerNotch: v })}
      />
      <Slider
        tone="imaging"
        label="Browse drag"
        min={0}
        max={40}
        value={dragPx}
        valueLabel={dragPx === 0 ? "Automatic" : `${dragPx} px per slice`}
        description="Pixels of drag per slice. Lower is faster. Automatic scales to the series length."
        onChange={(v) => update({ dragPixelsPerSlice: v > 0 ? v : null })}
      />
      <Switch
        tone="imaging"
        label="Acceleration"
        description="A quick run of wheel notches moves progressively further (up to 4×)."
        checked={prefs.acceleration}
        onChange={(v) => update({ acceleration: v })}
      />
      <ScrollPreview prefs={prefs} />
    </section>
  );
}

/** "Try it": wheel or drag here, with the settings above (a 120-image stand-in, no study needed). */
function ScrollPreview({ prefs }: { prefs: ScrollPreferences }) {
  const COUNT = 120;
  const [index, setIndex] = useState(60);
  const [wheel] = useState(createWheelScrollState);
  const [run] = useState(() => ({ last: Number.NEGATIVE_INFINITY, length: 0 }));
  const [drag, setDrag] = useState<{ y: number; acc: number } | null>(null);
  const move = (delta: number) => setIndex((i) => Math.max(0, Math.min(COUNT - 1, i + delta)));
  // Automatic drag in the viewer depends on the pane height / image count; show a typical value.
  const dragPx = dragPixelsPerSlice(Math.max(2, 600 / COUNT), prefs);
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Scroll preview: wheel or drag here"
      aria-valuemin={1}
      aria-valuemax={COUNT}
      aria-valuenow={index + 1}
      aria-valuetext={`Image ${index + 1} of ${COUNT}`}
      data-testid="scroll-preview"
      onWheel={(e) => {
        const now = performance.now();
        const steps = takeWheelSlices(wheel, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY, now);
        if (!steps) return;
        if (now - run.last < ACCELERATION_WINDOW_MS) run.length += 1;
        else run.length = 1;
        run.last = now;
        move(Math.sign(steps) * Math.abs(steps) * slicesForNotch(prefs, run.length));
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ y: e.clientY, acc: 0 });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const acc = drag.acc + (e.clientY - drag.y);
        const steps = Math.trunc(acc / dragPx);
        if (steps) move(steps);
        setDrag({ y: e.clientY, acc: acc - steps * dragPx });
      }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") move(1);
        if (e.key === "ArrowUp" || e.key === "ArrowLeft") move(-1);
      }}
      className="relative mt-2 flex h-14 cursor-ns-resize touch-none select-none items-center justify-between overflow-hidden rounded-lg border border-white/10 bg-black px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="text-xs text-white/60">Try it: wheel or drag here</span>
      <span className="text-sm font-medium tabular-nums text-white">
        Im {index + 1} / {COUNT}
      </span>
      {/* The bar's width is the dynamic value: the position in the stand-in stack. */}
      <span aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-accent" style={{ width: `${((index + 1) / COUNT) * 100}%` }} />
    </div>
  );
}
