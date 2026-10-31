// Keyboard map. Pure: KeyboardEvent-like → action, so it is unit-tested and
// the shortcut sheet is generated from the same table (one source of truth).
//
// Tool letters follow RadiAnt where RadiAnt documents one (B, W, M, Z, L, A,
// E, C, Y, P; Ctrl+0…4 zoom; Ctrl+arrows pan; F full screen; Ctrl+E export;
// Ctrl+O / Ctrl+Shift+O / Ctrl+Alt+O open) — a radiologist switching over
// should not have to relearn their hands.

export type ShortcutAction =
  | { type: "tool"; tool: string }
  | { type: "open"; what: "files" | "folder" | "disc" | "zip" }
  | { type: "slice"; delta: number }
  | { type: "sliceEdge"; where: "first" | "last" }
  | { type: "series"; delta: number }
  | { type: "zoomTo"; scale: number | "fit" }
  | { type: "zoomBy"; factor: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "preset"; ordinal: number }
  | { type: "presetDefault" }
  | { type: "customWindow" }
  | { type: "invert" }
  | { type: "rotate"; degrees: number }
  | { type: "flip"; axis: "h" | "v" }
  | { type: "reset" }
  | { type: "cine" }
  | { type: "cineFps"; delta: number }
  | { type: "layout"; rows: number; cols: number }
  | { type: "toggleOverlay" }
  | { type: "toggleAnnotations" }
  | { type: "toggleSync" }
  | { type: "toggleReferenceLines" }
  | { type: "toggleBrowser" }
  | { type: "fullscreen" }
  | { type: "distractionFree" }
  | { type: "maximizeCell" }
  | { type: "undoAnnotation" }
  | { type: "clearAnnotations" }
  | { type: "export" }
  | { type: "mpr" }
  | { type: "volume3d" }
  | { type: "fusion" }
  | { type: "help" }
  | { type: "escape" };

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

interface Binding {
  /** Display form, e.g. "Ctrl+Shift+O". "Mod" renders as ⌘ on macOS. */
  keys: string;
  does: string;
  group: "Open" | "Tools" | "Navigate" | "Window" | "View" | "Layout" | "Annotate" | "Advanced";
  match: (e: Required<Pick<KeyLike, "key">> & KeyLike, mod: boolean) => boolean;
  action: ShortcutAction;
}

const plain = (e: KeyLike, mod: boolean) => !mod && !e.altKey;
const keyIs = (e: KeyLike, ...keys: string[]) => keys.includes(e.key.length === 1 ? e.key.toLowerCase() : e.key);
const digit = (e: KeyLike) => (e.code?.startsWith("Digit") ? Number(e.code.slice(5)) : /^[0-9]$/.test(e.key) ? Number(e.key) : NaN);

const tool = (letter: string, toolName: string, does: string): Binding => ({
  keys: letter.toUpperCase(),
  does,
  group: "Tools",
  match: (e, mod) => plain(e, mod) && !e.shiftKey && keyIs(e, letter),
  action: { type: "tool", tool: toolName },
});

export const LAYOUT_SHORTCUTS: { rows: number; cols: number }[] = [
  { rows: 1, cols: 1 },
  { rows: 1, cols: 2 },
  { rows: 2, cols: 1 },
  { rows: 2, cols: 2 },
  { rows: 1, cols: 3 },
  { rows: 2, cols: 3 },
  { rows: 3, cols: 3 },
];

export const BINDINGS: Binding[] = [
  // Open
  { keys: "Mod+O", does: "Open DICOM files", group: "Open", match: (e, m) => m && !e.shiftKey && !e.altKey && keyIs(e, "o"), action: { type: "open", what: "files" } },
  { keys: "Mod+Shift+O", does: "Open a folder", group: "Open", match: (e, m) => m && !!e.shiftKey && !e.altKey && keyIs(e, "o"), action: { type: "open", what: "folder" } },
  { keys: "Mod+Alt+O", does: "Open CD / DVD / USB", group: "Open", match: (e, m) => m && !!e.altKey && keyIs(e, "o", "ø"), action: { type: "open", what: "disc" } },
  { keys: "Mod+Shift+Z", does: "Open a zip archive", group: "Open", match: (e, m) => m && !!e.shiftKey && keyIs(e, "z"), action: { type: "open", what: "zip" } },

  // Tools (left mouse button)
  tool("b", "StackScroll", "Browse slices"),
  tool("w", "WindowLevel", "Window / level"),
  tool("m", "Pan", "Move (pan)"),
  tool("z", "Zoom", "Zoom"),
  tool("l", "Length", "Length"),
  tool("a", "Angle", "Angle"),
  tool("c", "CobbAngle", "Cobb angle"),
  tool("e", "EllipticalROI", "Ellipse ROI (mean / SD / area)"),
  tool("r", "RectangleROI", "Rectangle ROI"),
  tool("o", "CircleROI", "Circle ROI"),
  tool("p", "PlanarFreehandROI", "Freehand ROI (pen)"),
  tool("x", "Probe", "Pixel value probe"),
  tool("y", "ArrowAnnotate", "Arrow with label"),
  tool("d", "Bidirectional", "Bidirectional (long / short axis)"),
  tool("g", "Magnify", "Magnifying glass"),

  // Navigate
  { keys: "↑ / ↓", does: "Previous / next image", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "ArrowUp"), action: { type: "slice", delta: -1 } },
  { keys: "", does: "", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "ArrowDown"), action: { type: "slice", delta: 1 } },
  { keys: "PgUp / PgDn", does: "Jump 10 images", group: "Navigate", match: (e, m) => plain(e, m) && (keyIs(e, "PageUp") || (!!e.shiftKey && keyIs(e, "ArrowUp"))), action: { type: "slice", delta: -10 } },
  { keys: "", does: "", group: "Navigate", match: (e, m) => plain(e, m) && (keyIs(e, "PageDown") || (!!e.shiftKey && keyIs(e, "ArrowDown"))), action: { type: "slice", delta: 10 } },
  { keys: "Home / End", does: "First / last image", group: "Navigate", match: (e, m) => plain(e, m) && keyIs(e, "Home"), action: { type: "sliceEdge", where: "first" } },
  { keys: "", does: "", group: "Navigate", match: (e, m) => plain(e, m) && keyIs(e, "End"), action: { type: "sliceEdge", where: "last" } },
  { keys: "← / →", does: "Previous / next series", group: "Navigate", match: (e, m) => plain(e, m) && keyIs(e, "ArrowLeft"), action: { type: "series", delta: -1 } },
  { keys: "", does: "", group: "Navigate", match: (e, m) => plain(e, m) && keyIs(e, "ArrowRight"), action: { type: "series", delta: 1 } },
  { keys: "Space", does: "Play / pause cine", group: "Navigate", match: (e, m) => plain(e, m) && e.key === " ", action: { type: "cine" } },
  { keys: "[ / ]", does: "Cine slower / faster", group: "Navigate", match: (e, m) => plain(e, m) && e.key === "[", action: { type: "cineFps", delta: -5 } },
  { keys: "", does: "", group: "Navigate", match: (e, m) => plain(e, m) && e.key === "]", action: { type: "cineFps", delta: 5 } },

  // Zoom / pan (RadiAnt)
  { keys: "Mod+0", does: "Fit to window", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 0, action: { type: "zoomTo", scale: "fit" } },
  { keys: "Mod+1 … 4", does: "Zoom 100 / 200 / 400 / 800 %", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 1, action: { type: "zoomTo", scale: 1 } },
  { keys: "", does: "", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 2, action: { type: "zoomTo", scale: 2 } },
  { keys: "", does: "", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 3, action: { type: "zoomTo", scale: 4 } },
  { keys: "", does: "", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 4, action: { type: "zoomTo", scale: 8 } },
  { keys: "Mod+= / Mod+−", does: "Zoom in / out", group: "View", match: (e, m) => m && keyIs(e, "=", "+"), action: { type: "zoomBy", factor: 1.25 } },
  { keys: "", does: "", group: "View", match: (e, m) => m && keyIs(e, "-", "_"), action: { type: "zoomBy", factor: 0.8 } },
  { keys: "Mod+Arrows", does: "Pan", group: "View", match: (e, m) => m && keyIs(e, "ArrowLeft"), action: { type: "pan", dx: -40, dy: 0 } },
  { keys: "", does: "", group: "View", match: (e, m) => m && keyIs(e, "ArrowRight"), action: { type: "pan", dx: 40, dy: 0 } },
  { keys: "", does: "", group: "View", match: (e, m) => m && keyIs(e, "ArrowUp"), action: { type: "pan", dx: 0, dy: -40 } },
  { keys: "", does: "", group: "View", match: (e, m) => m && keyIs(e, "ArrowDown"), action: { type: "pan", dx: 0, dy: 40 } },
  { keys: "I", does: "Invert greyscale", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "i"), action: { type: "invert" } },
  { keys: "H / V", does: "Flip horizontal / vertical", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "h"), action: { type: "flip", axis: "h" } },
  { keys: "", does: "", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "v"), action: { type: "flip", axis: "v" } },
  { keys: "Q / Shift+Q", does: "Rotate 90° right / left", group: "View", match: (e, m) => plain(e, m) && keyIs(e, "q"), action: { type: "rotate", degrees: 90 } },
  { keys: "Esc", does: "Reset view · leave full screen", group: "View", match: (e) => e.key === "Escape", action: { type: "escape" } },
  { keys: "Backspace", does: "Reset zoom, pan, window, rotation", group: "View", match: (e, m) => plain(e, m) && keyIs(e, "Backspace"), action: { type: "reset" } },
  { keys: "Mod+Shift+F12", does: "Show / hide DICOM overlay", group: "View", match: (e, m) => m && !!e.shiftKey && e.key === "F12", action: { type: "toggleOverlay" } },
  { keys: "F12", does: "Show / hide annotations", group: "View", match: (e, m) => !m && e.key === "F12", action: { type: "toggleAnnotations" } },
  { keys: "F", does: "Full screen", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "f"), action: { type: "fullscreen" } },
  { keys: "Shift+Alt+Enter", does: "Distraction-free reading", group: "View", match: (e) => !!e.shiftKey && !!e.altKey && e.key === "Enter", action: { type: "distractionFree" } },
  { keys: "Tab", does: "Show / hide series browser", group: "View", match: (e, m) => plain(e, m) && e.key === "Tab", action: { type: "toggleBrowser" } },

  // Window
  { keys: "1 … 9", does: "Window presets (by modality)", group: "Window", match: (e, m) => plain(e, m) && !e.shiftKey && digit(e) >= 1 && digit(e) <= 9, action: { type: "preset", ordinal: 1 } },
  { keys: "0", does: "Default window (from the file)", group: "Window", match: (e, m) => plain(e, m) && !e.shiftKey && digit(e) === 0, action: { type: "presetDefault" } },
  { keys: "Mod+F11", does: "Set exact WW / WL", group: "Window", match: (e, m) => m && e.key === "F11", action: { type: "customWindow" } },

  // Layout
  { keys: "Shift+1 … 7", does: "Layouts 1×1 · 1×2 · 2×1 · 2×2 · 1×3 · 2×3 · 3×3", group: "Layout", match: (e, m) => plain(e, m) && !!e.shiftKey && digit(e) >= 1 && digit(e) <= 7, action: { type: "layout", rows: 1, cols: 1 } },
  { keys: "Enter", does: "Maximise / restore the active viewport", group: "Layout", match: (e, m) => plain(e, m) && !e.shiftKey && e.key === "Enter", action: { type: "maximizeCell" } },
  { keys: "F5", does: "Synchronise scrolling", group: "Layout", match: (e) => e.key === "F5", action: { type: "toggleSync" } },
  { keys: "Mod+F12", does: "Reference lines", group: "Layout", match: (e, m) => m && !e.shiftKey && e.key === "F12", action: { type: "toggleReferenceLines" } },

  // Annotate
  { keys: "Mod+Z", does: "Undo last measurement", group: "Annotate", match: (e, m) => m && !e.shiftKey && keyIs(e, "z"), action: { type: "undoAnnotation" } },
  { keys: "Mod+Shift+Delete", does: "Clear measurements", group: "Annotate", match: (e, m) => m && !!e.shiftKey && (keyIs(e, "Delete") || keyIs(e, "Backspace")), action: { type: "clearAnnotations" } },
  { keys: "Mod+E", does: "Export images / video / DICOM", group: "Annotate", match: (e, m) => m && keyIs(e, "e"), action: { type: "export" } },

  // Advanced
  { keys: "Mod+M", does: "MPR (three planes, crosshairs)", group: "Advanced", match: (e, m) => m && !e.shiftKey && keyIs(e, "m"), action: { type: "mpr" } },
  { keys: "Mod+Shift+M", does: "3D volume rendering", group: "Advanced", match: (e, m) => m && !!e.shiftKey && keyIs(e, "m"), action: { type: "volume3d" } },
  { keys: "Mod+Shift+F", does: "PET / CT fusion", group: "Advanced", match: (e, m) => m && !!e.shiftKey && keyIs(e, "f"), action: { type: "fusion" } },
  { keys: "F1 / ?", does: "Keyboard shortcuts", group: "Advanced", match: (e) => e.key === "F1" || e.key === "?", action: { type: "help" } },
];

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Resolve a key event to an action. `mac` decides whether ⌘ or Ctrl is "Mod". */
export function resolveShortcut(e: KeyLike, mac = isMac()): ShortcutAction | null {
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;
  const event = { ...e, key: e.key ?? "" };
  for (const binding of BINDINGS) {
    if (!binding.match(event, mod)) continue;
    const action = binding.action;
    if (action.type === "preset") return { type: "preset", ordinal: digit(e) };
    if (action.type === "layout") return { type: "layout", ...LAYOUT_SHORTCUTS[digit(e) - 1] };
    if (action.type === "rotate" && e.shiftKey) return { type: "rotate", degrees: -90 };
    return action;
  }
  return null;
}

/** Rows for the shortcut sheet, with Mod rendered for this platform. */
export function shortcutSheet(mac = isMac()): { group: Binding["group"]; keys: string; does: string }[] {
  return BINDINGS.filter((b) => b.keys).map((b) => ({
    group: b.group,
    does: b.does,
    keys: b.keys.replace(/Mod\+/g, mac ? "⌘" : "Ctrl+").replace(/Alt\+/g, mac ? "⌥" : "Alt+").replace(/Shift\+/g, mac ? "⇧" : "Shift+"),
  }));
}
