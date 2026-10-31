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
  | { type: "cineFps"; delta: 1 | -1 }
  | { type: "preset"; ordinal: number }
  | { type: "overlay" }
  | { type: "mpr" }
  | { type: "layout" }
  | { type: "help" };

export interface HotkeyEventLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export interface HotkeyOptions {
  /**
   * `?` opens the viewer's own shortcut sheet. Off by default because the
   * student session owns `?` on `window` for its cheatsheet; the standalone
   * viewer (library, share link, local files) turns it on.
   */
  questionMarkHelp?: boolean;
}

/** Digit → left-button tool. The order a reading room reaches for them. */
export const TOOL_DIGITS: Record<string, string> = {
  "1": "StackScroll",
  "2": "WindowLevel",
  "3": "Zoom",
  "4": "Pan",
  "5": "Length",
};

/**
 * Letter → left-button tool, the mnemonic a PACS user already has. None of
 * these is a student-session key (C N P R T F [ Space ?).
 */
export const TOOL_LETTERS: Record<string, string> = {
  s: "StackScroll",
  w: "WindowLevel",
  z: "Zoom",
  m: "Pan",
  l: "Length",
  a: "Angle",
  e: "EllipticalROI",
  b: "RectangleROI",
};

/** "1 · S" — the tooltip and help sheet read this, so they cannot drift. */
export function shortcutForTool(tool: string): string | null {
  const keys: string[] = [];
  for (const [digit, name] of Object.entries(TOOL_DIGITS)) if (name === tool) keys.push(digit);
  for (const [letter, name] of Object.entries(TOOL_LETTERS)) {
    if (name === tool) keys.push(letter.toUpperCase());
  }
  return keys.length ? keys.join(" · ") : null;
}

export interface ShortcutRow {
  keys: string[];
  does: string;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

/** The viewer's help sheet. Grouped the way the toolbar is. */
export const VIEWER_SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Tools (left button · one finger)",
    rows: [
      { keys: ["1", "S"], does: "Scroll" },
      { keys: ["2", "W"], does: "Window / level" },
      { keys: ["3", "Z"], does: "Zoom" },
      { keys: ["4", "M"], does: "Pan" },
      { keys: ["5", "L"], does: "Length" },
      { keys: ["A"], does: "Angle" },
      { keys: ["E"], does: "Ellipse ROI" },
      { keys: ["B"], does: "Rectangle ROI" },
    ],
  },
  {
    title: "Stack",
    rows: [
      { keys: ["↑", "↓"], does: "Previous / next image" },
      { keys: ["PgUp", "PgDn"], does: "Jump 5% of the series (or Shift + ↑ ↓)" },
      { keys: ["Home", "End"], does: "First / last image" },
      { keys: ["K"], does: "Play / pause cine" },
      { keys: [",", "."], does: "Cine slower / faster" },
    ],
  },
  {
    title: "Display",
    rows: [
      { keys: ["Shift", "1…9"], does: "Window preset" },
      { keys: ["Shift", "0"], does: "Series default window" },
      { keys: ["I"], does: "Invert" },
      { keys: ["+", "−"], does: "Zoom in / out" },
      { keys: ["0"], does: "Reset view" },
      { keys: ["O"], does: "Overlay: full → basic → off" },
    ],
  },
  {
    title: "Layout",
    rows: [
      { keys: ["X"], does: "Stack ↔ MPR" },
      { keys: ["G"], does: "Cycle hanging layout (where offered)" },
      { keys: ["H"], does: "This sheet" },
    ],
  },
];

/** Mouse and touch map, shown under the keys. Bindings live in CornerstoneViewer. */
export const VIEWER_POINTER_HINTS: ShortcutRow[] = [
  { keys: ["Left drag"], does: "Selected tool" },
  { keys: ["Wheel"], does: "Scroll images" },
  { keys: ["Right drag"], does: "Zoom" },
  { keys: ["Middle drag"], does: "Pan" },
  { keys: ["Pinch"], does: "Zoom and pan (touch)" },
  { keys: ["One finger"], does: "Selected tool (touch)" },
  { keys: ["Double-click"], does: "Fit image to the pane" },
];

/** Printable hint for the toolbar/cheatsheet, in the same order. */
export const VIEWER_HOTKEY_HINTS: { keys: string; does: string }[] = VIEWER_SHORTCUT_GROUPS.flatMap(
  (group) => group.rows.map((row) => ({ keys: row.keys.join(" / "), does: row.does }))
);

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
  sliceCount: number = 0,
  options: HotkeyOptions = {}
): ViewerHotkeyAction | null {
  // Browser and OS combinations stay theirs.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const slice = sliceStepForKey(event.key, sliceCount, { shift: event.shiftKey });
  if (slice !== null) return { type: "slice", delta: slice };

  if (event.key === "Home") return { type: "sliceAbsolute", where: "first" };
  if (event.key === "End") return { type: "sliceAbsolute", where: "last" };

  // Shift + digit is a window preset; a bare digit is a tool. Shift+0 is the
  // series' own window ("full dynamic"), ordinal 0.
  if (/^[0-9]$/.test(event.key) && event.shiftKey) {
    return { type: "preset", ordinal: Number(event.key) };
  }
  // Shift+digit arrives as the shifted glyph on many layouts (! " # …).
  const shifted = "!@#$%^&*(".indexOf(event.key);
  if (shifted >= 0) return { type: "preset", ordinal: shifted + 1 };
  if (event.key === ")") return { type: "preset", ordinal: 0 };

  const tool = TOOL_DIGITS[event.key];
  if (tool) return { type: "tool", tool };

  if (event.key === "?") return options.questionMarkHelp ? { type: "help" } : null;

  const letter = event.key.length === 1 ? event.key.toLowerCase() : "";
  const letterTool = TOOL_LETTERS[letter];
  if (letterTool) return { type: "tool", tool: letterTool };

  switch (event.key) {
    case "+":
    case "=":
      return { type: "zoom", factor: 1.25 };
    case "-":
    case "_":
      return { type: "zoom", factor: 1 / 1.25 };
    case "0":
      return { type: "reset" };
    case ",":
    case "<":
      return { type: "cineFps", delta: -1 };
    case ".":
    case ">":
      return { type: "cineFps", delta: 1 };
  }

  switch (letter) {
    case "i":
      return { type: "invert" };
    case "k":
      return { type: "cine" };
    case "o":
      return { type: "overlay" };
    case "x":
      return { type: "mpr" };
    case "g":
      return { type: "layout" };
    case "h":
      return { type: "help" };
    default:
      return null;
  }
}
