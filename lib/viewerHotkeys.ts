// Keyboard control for the viewport.
//
// `docs/UI_AUDIT.md` backlog #3: "Tool shortcuts (1–4 for W/L, pan, zoom,
// scroll) and a real menu widget." This is the shortcut half.
//
// Scope matters here. The student session already owns a set of GLOBAL keys on
// `window` — Space (mic), `?` (cheatsheet), C/N/P/R/T/F, `[` (series rail) —
// so a second global listener would fight it. These keys are therefore bound
// to the VIEWPORT ELEMENT, which the viewer makes focusable. A reader tabs or
// clicks into the image and then has a reading-room keyboard; nothing else on
// the page changes behaviour. That also makes the viewer keyboard-operable at
// all, which it was not (`role="img"` on a non-focusable div).
//
// Deliberately NOT bound: any bare letter the session already claims, and
// anything with a modifier — Ctrl/Cmd/Alt combinations belong to the browser
// and the OS, and a radiologist's screenshot hotkey must keep working.
//
// Pure resolution: key in, intent out. The viewer maps intents onto the
// imperative handle.

import { sliceStepForKey } from "./sliceScrollbar";

export type ViewerHotkeyAction =
  | { type: "tool"; tool: string }
  | { type: "slice"; delta: number }
  | { type: "sliceAbsolute"; where: "first" | "last" }
  | { type: "zoom"; factor: number }
  | { type: "invert" }
  | { type: "reset" }
  | { type: "cine" }
  | { type: "preset"; ordinal: number };

export interface HotkeyEventLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

/** Digit → left-button tool. The order a reading room reaches for them. */
export const TOOL_DIGITS: Record<string, string> = {
  "1": "StackScroll",
  "2": "WindowLevel",
  "3": "Zoom",
  "4": "Pan",
  "5": "Length",
};

/** Printable hint for the toolbar/cheatsheet, in the same order. */
export const VIEWER_HOTKEY_HINTS: { keys: string; does: string }[] = [
  { keys: "1 – 5", does: "Scroll · Window/Level · Zoom · Pan · Length" },
  { keys: "↑ ↓", does: "Previous / next slice (Shift or PgUp/PgDn jumps)" },
  { keys: "Home / End", does: "First / last slice" },
  { keys: "+ / −", does: "Zoom in / out" },
  { keys: "I", does: "Invert greyscale" },
  { keys: "0", does: "Reset zoom, pan and window" },
  { keys: "K", does: "Play or pause cine" },
  { keys: "Shift + 1…9", does: "Window preset" },
];

/** True when the event target is a field we must never hijack. */
export function isTextTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return node.isContentEditable === true;
}

/**
 * The viewport action for a key press, or `null` to let the event through.
 *
 * `sliceCount` only shapes the coarse step (Shift/PageUp jump a twentieth of
 * the series), so passing 0 still resolves the single-slice keys.
 */
export function resolveViewerHotkey(
  event: HotkeyEventLike,
  sliceCount: number = 0
): ViewerHotkeyAction | null {
  // Browser and OS combinations stay theirs.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const slice = sliceStepForKey(event.key, sliceCount, { shift: event.shiftKey });
  if (slice !== null) return { type: "slice", delta: slice };

  if (event.key === "Home") return { type: "sliceAbsolute", where: "first" };
  if (event.key === "End") return { type: "sliceAbsolute", where: "last" };

  // Shift + digit is a window preset; a bare digit is a tool.
  if (/^[1-9]$/.test(event.key) && event.shiftKey) {
    return { type: "preset", ordinal: Number(event.key) };
  }
  // Shift+digit arrives as the shifted glyph on many layouts (! " # …).
  const shifted = "!@#$%^&*(".indexOf(event.key);
  if (shifted >= 0) return { type: "preset", ordinal: shifted + 1 };

  const tool = TOOL_DIGITS[event.key];
  if (tool) return { type: "tool", tool };

  switch (event.key) {
    case "+":
    case "=":
      return { type: "zoom", factor: 1.25 };
    case "-":
    case "_":
      return { type: "zoom", factor: 1 / 1.25 };
    case "0":
      return { type: "reset" };
    case "i":
    case "I":
      return { type: "invert" };
    case "k":
    case "K":
      return { type: "cine" };
    default:
      return null;
  }
}
