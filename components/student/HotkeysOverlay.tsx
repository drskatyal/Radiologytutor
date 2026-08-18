"use client";

import { Modal, Kbd } from "@/components/ui";

const ROWS: { keys: string[]; does: string }[] = [
  { keys: ["Space"], does: "Hold to speak (push-to-talk)" },
  { keys: ["?"], does: "Show or hide this cheatsheet" },
  { keys: ["R"], does: "Reveal the current finding" },
  { keys: ["N"], does: "Skip / next finding" },
  { keys: ["P"], does: "Previous finding" },
  { keys: ["T"], does: "Toggle tutor rail" },
  { keys: ["Esc"], does: "Close rail or this overlay" },
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
    </Modal>
  );
}
