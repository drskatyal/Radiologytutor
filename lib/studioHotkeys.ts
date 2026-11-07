// Recording Studio sketch shortcuts.
//
// Scope: the author Recording Studio page only. The student session owns
// Space ? Esc C N P R T [ on its own page, and the record take owns Alt+X
// (hold-to-record in useRecordReplay). None of those are claimed here.
//
// Inside the Studio these keys are taken in the CAPTURE phase on `window`, so
// they win over the viewport's own letter shortcuts while the image has focus.
// The viewer tools they shadow (M Pan, A Angle, E Ellipse ROI, O overlay)
// stay one click away on the viewer toolbar and on the digit keys (4 = Pan).
//
// Excalidraw muscle memory where it does not fight the student keys:
//   D draw (pen) · A arrow · O ellipse · Q text (T is the student rail)
//   E eraser · M finding marker · V / Esc back to the viewer's mouse tools
//   Ctrl/⌘+Z undo · Ctrl/⌘+Shift+Z or Ctrl+Y redo · U undo (one hand on the mouse)

import type { TeacherSketchTool } from "./teacherSketch";

export type StudioHotkeyAction =
  | { type: "tool"; tool: TeacherSketchTool }
  | { type: "marker" }
  | { type: "undo" }
  | { type: "redo" };

export interface StudioKeyLike {
  key: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** Bare letter → tool. Kept disjoint from STUDENT_SESSION_KEYS (tested). */
export const STUDIO_TOOL_KEYS: Record<string, TeacherSketchTool> = {
  d: "pen",
  a: "arrow",
  o: "ellipse",
  q: "text",
  e: "eraser",
  v: "select",
};

export const STUDIO_MARKER_KEY = "m";

/** Keys the student session binds on its page. The Studio must not reuse them. */
export const STUDENT_SESSION_KEYS = [" ", "?", "escape", "c", "n", "p", "r", "t", "["] as const;

export const STUDIO_SHORTCUTS: { keys: string; does: string }[] = [
  { keys: "M", does: "Drop a numbered finding marker at the pointer" },
  { keys: "D", does: "Pen" },
  { keys: "A", does: "Arrow" },
  { keys: "O", does: "Ellipse" },
  { keys: "Q", does: "Text" },
  { keys: "E", does: "Eraser" },
  { keys: "V / Esc", does: "Back to viewer tools" },
  { keys: "⌘/Ctrl Z · U", does: "Undo" },
  { keys: "⌘/Ctrl ⇧ Z", does: "Redo" },
  { keys: "Alt + X (hold)", does: "Record narration" },
];

export const STUDIO_TOOL_SHORTCUT: Record<TeacherSketchTool, string> = {
  select: "V",
  pen: "D",
  arrow: "A",
  ellipse: "O",
  text: "Q",
  marker: "M",
  eraser: "E",
};

/** Resolve a Studio key, or null to let it through untouched. */
export function resolveStudioHotkey(event: StudioKeyLike): StudioHotkeyAction | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey) return null; // Alt+X belongs to the record take; Alt+anything else to the OS.
  if (mod) {
    if (key === "z") return event.shiftKey ? { type: "redo" } : { type: "undo" };
    if (key === "y" && event.ctrlKey) return { type: "redo" };
    return null;
  }
  if (key === "Escape") return { type: "tool", tool: "select" };
  if (event.shiftKey) return null;
  if (key === STUDIO_MARKER_KEY) return { type: "marker" };
  if (key === "u") return { type: "undo" };
  const tool = STUDIO_TOOL_KEYS[key];
  return tool ? { type: "tool", tool } : null;
}
