"use client";

import { Modal, Kbd } from "@/components/ui";
import { SERIES_RAIL_TOGGLE_KEY } from "@/lib/seriesRailPreference";

// Session keys are global. Viewport keys are scoped to the image — click or
// tab into it first — so they cannot fight the session's bindings
// (lib/viewerHotkeys.ts).
const ROWS: { keys: string[]; does: string }[] = [
  { keys: ["Space"], does: "Interrupt the attending, then hold to answer" },
  { keys: ["Wheel"], does: "Scroll the stack" },
  { keys: ["Drag"], does: "Scroll the stack (default). One finger does the same." },
  { keys: ["Pinch"], does: "Zoom" },
  { keys: ["Right-drag"], does: "Zoom" },
  { keys: ["Middle-drag"], does: "Pan" },
  { keys: ["W/L"], does: "Window and level — select the tool, then drag" },
  { keys: ["?"], does: "Show or hide this cheatsheet" },
  { keys: ["C"], does: "Toggle compare (second series / prior)" },
  { keys: ["R"], does: "Reveal the current finding (Exam)" },
  { keys: ["N"], does: "Next finding" },
  { keys: ["P"], does: "Previous finding" },
  { keys: ["T"], does: "Toggle tutor rail" },
  { keys: ["F"], does: "Fullscreen the viewer" },
  { keys: [SERIES_RAIL_TOGGLE_KEY], does: "Collapse or expand the series list" },
  { keys: ["Esc"], does: "Exit fullscreen, or close the rail" },
];

/** Keys the focused viewport answers. Click or tab into the image first. */
const VIEWPORT_ROWS: { keys: string[]; does: string }[] = [
  { keys: ["1", "2", "3", "4", "5"], does: "Scroll · Window/Level · Zoom · Pan · Length" },
  { keys: ["↑", "↓"], does: "Previous / next slice — hold Shift to jump" },
  { keys: ["PgUp", "PgDn"], does: "Jump a twentieth of the series" },
  { keys: ["Home", "End"], does: "First / last slice" },
  { keys: ["+", "−"], does: "Zoom in / out" },
  { keys: ["I"], does: "Invert greyscale" },
  { keys: ["0"], does: "Reset zoom, pan and window" },
  { keys: ["K"], does: "Play or pause cine" },
  { keys: ["Shift", "1…9"], does: "Window preset" },
];

export function HotkeysOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reading-room keys"
      description="Keep your hands on the keyboard. The image stays the composition."
      size="sm"
    >
      <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
        <ul className="flex flex-col gap-2">
          {ROWS.map((row) => (
            <li key={row.does} className="flex items-center justify-between gap-3">
              <span className="text-sm text-secondary">{row.does}</span>
              <span className="flex shrink-0 items-center gap-1">
                {row.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <section className="flex flex-col gap-2 border-t border-subtle pt-4">
          <h3 className="text-sm font-medium text-primary">On the image</h3>
          <p className="text-xs text-secondary">
            Click or tab into the image first — these keys belong to the viewport.
          </p>
          <ul className="flex flex-col gap-2">
            {VIEWPORT_ROWS.map((row) => (
              <li key={row.does} className="flex items-center justify-between gap-3">
                <span className="text-sm text-secondary">{row.does}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {row.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}
