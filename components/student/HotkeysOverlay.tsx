"use client";

import { Modal, Kbd } from "@/components/ui";
import { SERIES_RAIL_TOGGLE_KEY } from "@/lib/seriesRailPreference";

const ROWS: { keys: string[]; does: string }[] = [
  { keys: ["Space"], does: "Interrupt the attending, then hold to answer" },
  { keys: ["Wheel"], does: "Scroll the stack" },
  { keys: ["Right-drag"], does: "Zoom" },
  { keys: ["Middle-drag"], does: "Pan" },
  { keys: ["Left-drag"], does: "Use the tool selected on the image" },
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
      <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
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
    </Modal>
  );
}
