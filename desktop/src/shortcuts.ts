// Keyboard map — and, through the shared bindings engine, every mouse button
// and wheel the reader binds to a command. Pure: event-like → action, so it is
// unit-tested and the sheet, tooltips and menus render from the same table
// (one source of truth: docs/BINDINGS_DESIGN.md).
//
// Tool letters follow RadiAnt where RadiAnt documents one (B, W, M, Z, L, A,
// E, C, Y, P; Ctrl+0…4 zoom; Ctrl+arrows pan; F full screen; Ctrl+E export;
// Ctrl+O / Ctrl+Shift+O / Ctrl+Alt+O open) — a radiologist switching over
// should not have to relearn their hands.

import {
  findConflict,
  getLiveBindings,
  inputIndex,
  inputKind,
  inputLabel,
  isCustomised,
  isMac,
  keyLabel,
  keySpecOf,
  normalizeSpec,
  sameSpec,
  effectiveInputs,
  withMouseCommands,
  type BindingCommand,
  type BindingOverrides,
  type BindingTable,
  type KeyLike,
} from "@flowrad/viewer-core/bindings";

export { isMac, keyLabel, keySpecOf };
export type { KeyLike };

export type ShortcutAction =
  | { type: "tool"; tool: string }
  | { type: "open"; what: "files" | "folder" | "disc" | "zip" | "pacs" }
  | { type: "slice"; delta: number }
  /** About a tenth of the series per press (RadiAnt PgUp / PgDn). */
  | { type: "slicePage"; dir: -1 | 1 }
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
  /** Rotation and flips back to the file's orientation (zoom, pan, window kept). */
  | { type: "orientReset" }
  | { type: "reset" }
  | { type: "cine" }
  | { type: "cineFps"; delta: number }
  | { type: "layout"; rows: number; cols: number }
  | { type: "toggleOverlay" }
  | { type: "toggleAnnotations" }
  | { type: "toggleSync" }
  | { type: "toggleSyncVoi" }
  | { type: "toggleSyncZoom" }
  | { type: "linkAtCurrent" }
  | { type: "toggleReferenceLines" }
  /** Show / hide (collapse to a rail) the series panel. */
  | { type: "toggleBrowser" }
  | { type: "fullscreen" }
  | { type: "distractionFree" }
  | { type: "maximizeCell" }
  | { type: "undoAnnotation" }
  | { type: "redoAnnotation" }
  | { type: "voice" }
  /** Open the active viewport (or the whole layout) in a window on the next monitor. */
  | { type: "sendToMonitor"; scope: "viewport" | "layout" }
  | { type: "clearAnnotations" }
  | { type: "export" }
  | { type: "mpr" }
  | { type: "volume3d" }
  | { type: "fusion" }
  /** Quick single-plane reformat of the active viewport's series. */
  | { type: "reformat"; plane: "axial" | "coronal" | "sagittal" }
  /** Slab mode: Slice → MIP → MinIP → AvgIP → Slice. */
  | { type: "slabCycle" }
  | { type: "slabThickness"; deltaMm: number }
  | { type: "help" }
  | { type: "escape" };

export interface Binding {
  /** Stable command id (settings, exported JSON, mouse buttons bound to it). Rows without one are ranges or notes. */
  id?: string;
  /** The default key as a spec ("Mod+Shift+O", "ArrowUp"); for rows without an id, display text ("1 … 9"). */
  keys: string;
  /** Further default keys (listed in the sheet, claimed for conflicts). */
  alt?: string[];
  does: string;
  group: "Open" | "Tools" | "Navigate" | "Window" | "View" | "Layout" | "Annotate" | "Advanced";
  /** The default keys' matcher: lenient (layouts, Caps Lock, macOS Option letters). */
  match: (e: Required<Pick<KeyLike, "key">> & KeyLike, mod: boolean) => boolean;
  action: ShortcutAction;
}

const plain = (e: KeyLike, mod: boolean) => !mod && !e.altKey && !e.ctrlKey && !e.metaKey;
const keyIs = (e: KeyLike, ...keys: string[]) => keys.includes(e.key.length === 1 ? e.key.toLowerCase() : e.key);
/** US-layout shifted digits, for events that arrive without `code` (some WebKitGTK/X11 paths). */
const SHIFTED_DIGITS: Record<string, number> = { "!": 1, "@": 2, "#": 3, $: 4, "%": 5, "^": 6, "&": 7, "*": 8, "(": 9, ")": 0 };
const digit = (e: KeyLike) =>
  e.code?.startsWith("Digit")
    ? Number(e.code.slice(5))
    : /^[0-9]$/.test(e.key)
      ? Number(e.key)
      : e.shiftKey && e.key in SHIFTED_DIGITS
        ? SHIFTED_DIGITS[e.key]
        : NaN;

const tool = (letter: string, toolName: string, does: string): Binding => ({
  id: `tool.${letter}`,
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
  { id: "open.files", keys: "Mod+O", does: "Open DICOM files", group: "Open", match: (e, m) => m && !e.shiftKey && !e.altKey && keyIs(e, "o"), action: { type: "open", what: "files" } },
  { id: "open.folder", keys: "Mod+Shift+O", does: "Open a folder", group: "Open", match: (e, m) => m && !!e.shiftKey && !e.altKey && keyIs(e, "o"), action: { type: "open", what: "folder" } },
  { id: "open.disc", keys: "Mod+Alt+O", does: "Open CD / DVD / USB", group: "Open", match: (e, m) => m && !!e.altKey && keyIs(e, "o", "ø"), action: { type: "open", what: "disc" } },
  { id: "open.pacs", keys: "Mod+Shift+P", does: "Query / retrieve from a PACS", group: "Open", match: (e, m) => m && !!e.shiftKey && keyIs(e, "p"), action: { type: "open", what: "pacs" } },
  { id: "open.zip", keys: "Mod+Shift+Z", does: "Open a zip archive", group: "Open", match: (e, m) => m && !!e.shiftKey && keyIs(e, "z"), action: { type: "open", what: "zip" } },

  // Tools (left mouse button)
  tool("b", "StackScroll", "Browse slices"),
  tool("w", "WindowLevel", "Window / level"),
  tool("p", "Pan", "Pan"),
  tool("m", "Length", "Measure (length)"),
  tool("z", "Zoom", "Zoom"),
  tool("l", "Length", "Length"),
  tool("a", "Angle", "Angle"),
  tool("c", "CobbAngle", "Cobb angle"),
  tool("e", "EllipticalROI", "Ellipse ROI (mean / SD / area)"),
  // R is rotate (as on the web viewer); the rectangle is S (square).
  tool("s", "RectangleROI", "Rectangle ROI"),
  tool("o", "CircleROI", "Circle ROI"),
  tool("n", "PlanarFreehandROI", "Freehand ROI"),
  tool("x", "Probe", "Pixel value probe"),
  tool("y", "ArrowAnnotate", "Arrow with label"),
  tool("d", "Bidirectional", "Bidirectional (long / short axis)"),
  tool("g", "Magnify", "Magnifying glass"),

  // Navigate
  { id: "slice.prev", keys: "ArrowUp", does: "Previous image", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "ArrowUp"), action: { type: "slice", delta: -1 } },
  { id: "slice.next", keys: "ArrowDown", does: "Next image", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "ArrowDown"), action: { type: "slice", delta: 1 } },
  { id: "series.prev", keys: "ArrowLeft", alt: ["[", "Shift+Tab"], does: "Previous series (active viewport)", group: "Navigate", match: (e, m) => plain(e, m) && ((!e.shiftKey && (keyIs(e, "ArrowLeft") || e.key === "[")) || (!!e.shiftKey && e.key === "Tab")), action: { type: "series", delta: -1 } },
  { id: "series.next", keys: "ArrowRight", alt: ["]", "Tab"], does: "Next series (active viewport)", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && (keyIs(e, "ArrowRight") || e.key === "]" || e.key === "Tab"), action: { type: "series", delta: 1 } },
  { id: "page.prev", keys: "PageUp", alt: ["Shift+ArrowUp"], does: "Jump back 10% of the images", group: "Navigate", match: (e, m) => plain(e, m) && (keyIs(e, "PageUp") || (!!e.shiftKey && keyIs(e, "ArrowUp"))), action: { type: "slicePage", dir: -1 } },
  { id: "page.next", keys: "PageDown", alt: ["Shift+ArrowDown"], does: "Jump forward 10% of the images", group: "Navigate", match: (e, m) => plain(e, m) && (keyIs(e, "PageDown") || (!!e.shiftKey && keyIs(e, "ArrowDown"))), action: { type: "slicePage", dir: 1 } },
  { id: "slice.first", keys: "Home", does: "First image", group: "Navigate", match: (e, m) => plain(e, m) && keyIs(e, "Home"), action: { type: "sliceEdge", where: "first" } },
  { id: "slice.last", keys: "End", does: "Last image", group: "Navigate", match: (e, m) => plain(e, m) && keyIs(e, "End"), action: { type: "sliceEdge", where: "last" } },
  { id: "cine", keys: "Space", does: "Play / pause cine", group: "Navigate", match: (e, m) => plain(e, m) && e.key === " ", action: { type: "cine" } },
  { id: "cine.slower", keys: "Shift+[", does: "Cine slower", group: "Navigate", match: (e, m) => plain(e, m) && (e.key === "{" || (!!e.shiftKey && e.key === "[")), action: { type: "cineFps", delta: -5 } },
  { id: "cine.faster", keys: "Shift+]", does: "Cine faster", group: "Navigate", match: (e, m) => plain(e, m) && (e.key === "}" || (!!e.shiftKey && e.key === "]")), action: { type: "cineFps", delta: 5 } },

  // Zoom / pan (RadiAnt)
  { id: "zoom.fit", keys: "Mod+0", does: "Fit to window", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 0, action: { type: "zoomTo", scale: "fit" } },
  { id: "zoom.100", keys: "Mod+1", does: "Zoom 100 %", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 1, action: { type: "zoomTo", scale: 1 } },
  { id: "zoom.200", keys: "Mod+2", does: "Zoom 200 %", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 2, action: { type: "zoomTo", scale: 2 } },
  { id: "zoom.400", keys: "Mod+3", does: "Zoom 400 %", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 3, action: { type: "zoomTo", scale: 4 } },
  { id: "zoom.800", keys: "Mod+4", does: "Zoom 800 %", group: "View", match: (e, m) => m && !e.shiftKey && digit(e) === 4, action: { type: "zoomTo", scale: 8 } },
  { id: "zoom.in", keys: "Mod+=", does: "Zoom in", group: "View", match: (e, m) => m && keyIs(e, "=", "+"), action: { type: "zoomBy", factor: 1.25 } },
  { id: "zoom.out", keys: "Mod+-", does: "Zoom out", group: "View", match: (e, m) => m && keyIs(e, "-", "_"), action: { type: "zoomBy", factor: 0.8 } },
  { id: "pan.left", keys: "Mod+ArrowLeft", does: "Pan left", group: "View", match: (e, m) => m && keyIs(e, "ArrowLeft"), action: { type: "pan", dx: -40, dy: 0 } },
  { id: "pan.right", keys: "Mod+ArrowRight", does: "Pan right", group: "View", match: (e, m) => m && keyIs(e, "ArrowRight"), action: { type: "pan", dx: 40, dy: 0 } },
  { id: "pan.up", keys: "Mod+ArrowUp", does: "Pan up", group: "View", match: (e, m) => m && keyIs(e, "ArrowUp"), action: { type: "pan", dx: 0, dy: -40 } },
  { id: "pan.down", keys: "Mod+ArrowDown", does: "Pan down", group: "View", match: (e, m) => m && keyIs(e, "ArrowDown"), action: { type: "pan", dx: 0, dy: 40 } },
  { id: "invert", keys: "I", does: "Invert greyscale", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "i"), action: { type: "invert" } },
  { id: "flip.h", keys: "H", does: "Flip horizontal", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "h"), action: { type: "flip", axis: "h" } },
  { id: "flip.v", keys: "V", does: "Flip vertical", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "v"), action: { type: "flip", axis: "v" } },
  // Q / Shift+Q: the earlier rotate keys keep working.
  { id: "rotate", keys: "R", alt: ["Q"], does: "Rotate 90° clockwise", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "r", "q"), action: { type: "rotate", degrees: 90 } },
  { id: "rotate.ccw", keys: "Shift+R", alt: ["Shift+Q"], does: "Rotate 90° anticlockwise", group: "View", match: (e, m) => plain(e, m) && !!e.shiftKey && keyIs(e, "r", "q"), action: { type: "rotate", degrees: -90 } },
  { id: "orient.reset", keys: "Shift+Backspace", does: "Reset rotation and flips", group: "View", match: (e, m) => plain(e, m) && !!e.shiftKey && keyIs(e, "Backspace"), action: { type: "orientReset" } },
  { id: "escape", keys: "Escape", does: "Cancel the tool / drawing · leave full screen", group: "View", match: (e) => e.key === "Escape", action: { type: "escape" } },
  { id: "reset", keys: "Backspace", does: "Reset zoom, pan, window, rotation", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "Backspace"), action: { type: "reset" } },
  { id: "overlay", keys: "Mod+Shift+F12", does: "Show / hide DICOM overlay", group: "View", match: (e, m) => m && !!e.shiftKey && e.key === "F12", action: { type: "toggleOverlay" } },
  { id: "annotations", keys: "F12", does: "Show / hide annotations", group: "View", match: (e, m) => !m && e.key === "F12", action: { type: "toggleAnnotations" } },
  { id: "fullscreen", keys: "F", does: "Full screen", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "f"), action: { type: "fullscreen" } },
  { id: "distractionFree", keys: "Alt+Shift+Enter", does: "Distraction-free reading", group: "View", match: (e) => !!e.shiftKey && !!e.altKey && e.key === "Enter", action: { type: "distractionFree" } },
  { id: "seriesPanel", keys: "Mod+B", does: "Show / hide the series panel", group: "View", match: (e, m) => m && !e.shiftKey && keyIs(e, "b"), action: { type: "toggleBrowser" } },

  // Window
  { keys: "1 … 9", does: "Window presets (by modality)", group: "Window", match: (e, m) => plain(e, m) && !e.shiftKey && digit(e) >= 1 && digit(e) <= 9, action: { type: "preset", ordinal: 1 } },
  { id: "preset.default", keys: "0", does: "Default window (from the file)", group: "Window", match: (e, m) => plain(e, m) && !e.shiftKey && digit(e) === 0, action: { type: "presetDefault" } },
  { id: "window.custom", keys: "Mod+F11", does: "Set exact WW / WL", group: "Window", match: (e, m) => m && e.key === "F11", action: { type: "customWindow" } },

  // Layout
  { keys: "Shift+1 … 7", does: "Layouts 1×1 · 1×2 · 2×1 · 2×2 · 1×3 · 2×3 · 3×3", group: "Layout", match: (e, m) => plain(e, m) && !!e.shiftKey && digit(e) >= 1 && digit(e) <= 7, action: { type: "layout", rows: 1, cols: 1 } },
  { id: "maximize", keys: "Enter", does: "Maximise / restore the active viewport", group: "Layout", match: (e, m) => plain(e, m) && !e.shiftKey && e.key === "Enter", action: { type: "maximizeCell" } },
  { id: "sync.scroll", keys: "F5", does: "Synchronise scrolling (by position)", group: "Layout", match: (e) => e.key === "F5" && !e.shiftKey && !e.altKey, action: { type: "toggleSync" } },
  { id: "sync.voi", keys: "Shift+F5", does: "Synchronise window / level", group: "Layout", match: (e) => e.key === "F5" && !!e.shiftKey && !e.altKey, action: { type: "toggleSyncVoi" } },
  { id: "sync.zoom", keys: "Alt+F5", does: "Synchronise zoom and pan", group: "Layout", match: (e) => e.key === "F5" && !!e.altKey && !e.shiftKey, action: { type: "toggleSyncZoom" } },
  { id: "window.sendViewport", keys: "Mod+Shift+N", does: "Open the active viewport in a window on the next monitor", group: "Layout", match: (e, m) => m && !!e.shiftKey && !e.altKey && keyIs(e, "n"), action: { type: "sendToMonitor", scope: "viewport" } },
  { id: "window.sendLayout", keys: "Mod+Alt+N", does: "Send the whole layout to a window on the next monitor", group: "Layout", match: (e, m) => m && !!e.altKey && !e.shiftKey && (e.code === "KeyN" || keyIs(e, "n")), action: { type: "sendToMonitor", scope: "layout" } },
  { id: "sync.link", keys: "Mod+Shift+L", does: "Link viewports at what they show now (register a prior / other FOV)", group: "Layout", match: (e, m) => m && !!e.shiftKey && keyIs(e, "l"), action: { type: "linkAtCurrent" } },
  { id: "referenceLines", keys: "Mod+F12", does: "Reference lines", group: "Layout", match: (e, m) => m && !e.shiftKey && e.key === "F12", action: { type: "toggleReferenceLines" } },

  // Annotate
  { id: "undo", keys: "Mod+Z", does: "Undo (measurements, arrows, deletes)", group: "Annotate", match: (e, m) => m && !e.shiftKey && keyIs(e, "z"), action: { type: "undoAnnotation" } },
  { id: "redo", keys: "Mod+Y", does: "Redo", group: "Annotate", match: (e, m) => m && !e.shiftKey && keyIs(e, "y"), action: { type: "redoAnnotation" } },
  { keys: "Del", does: "Delete the selected annotation (click it first)", group: "Annotate", match: () => false, action: { type: "undoAnnotation" } },
  { id: "tool.eraser", keys: "Shift+E", does: "Eraser: click an annotation to delete it", group: "Annotate", match: (e, m) => plain(e, m) && !!e.shiftKey && keyIs(e, "e"), action: { type: "tool", tool: "Eraser" } },
  { keys: "Right-click", does: "Annotation menu: delete, label, copy value, delete all", group: "Annotate", match: () => false, action: { type: "undoAnnotation" } },
  { id: "annotations.clear", keys: "Mod+Shift+Backspace", alt: ["Mod+Shift+Delete"], does: "Clear measurements", group: "Annotate", match: (e, m) => m && !!e.shiftKey && (keyIs(e, "Delete") || keyIs(e, "Backspace")), action: { type: "clearAnnotations" } },
  { id: "export", keys: "Mod+E", does: "Export images / video / DICOM", group: "Annotate", match: (e, m) => m && keyIs(e, "e"), action: { type: "export" } },

  // Advanced
  { id: "mpr", keys: "Mod+M", does: "MPR (three planes, crosshairs)", group: "Advanced", match: (e, m) => m && !e.shiftKey && keyIs(e, "m"), action: { type: "mpr" } },
  { id: "volume3d", keys: "Mod+Shift+M", does: "3D volume rendering", group: "Advanced", match: (e, m) => m && !!e.shiftKey && keyIs(e, "m"), action: { type: "volume3d" } },
  { id: "fusion", keys: "Mod+Shift+F", does: "PET / CT fusion", group: "Advanced", match: (e, m) => m && !!e.shiftKey && keyIs(e, "f"), action: { type: "fusion" } },
  { id: "reformat.coronal", keys: "Alt+C", does: "Coronal reformat in the active viewport", group: "Advanced", match: (e, m) => !m && !!e.altKey && !e.shiftKey && (e.code === "KeyC" || keyIs(e, "c", "ç")), action: { type: "reformat", plane: "coronal" } },
  { id: "reformat.sagittal", keys: "Alt+S", does: "Sagittal reformat in the active viewport", group: "Advanced", match: (e, m) => !m && !!e.altKey && !e.shiftKey && (e.code === "KeyS" || keyIs(e, "s", "ß")), action: { type: "reformat", plane: "sagittal" } },
  { id: "reformat.axial", keys: "Alt+A", does: "Axial slab in the active viewport", group: "Advanced", match: (e, m) => !m && !!e.altKey && !e.shiftKey && (e.code === "KeyA" || keyIs(e, "a", "å")), action: { type: "reformat", plane: "axial" } },
  { id: "slab.cycle", keys: "T", does: "Slab: Slice → MIP → MinIP → AvgIP", group: "Advanced", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "t"), action: { type: "slabCycle" } },
  { id: "slab.thicker", keys: "Mod+]", does: "Thicker slab (+2 mm)", group: "Advanced", match: (e, m) => m && !e.shiftKey && (e.key === "]" || e.code === "BracketRight"), action: { type: "slabThickness", deltaMm: 2 } },
  { id: "slab.thinner", keys: "Mod+[", does: "Thinner slab (−2 mm)", group: "Advanced", match: (e, m) => m && !e.shiftKey && (e.key === "[" || e.code === "BracketLeft"), action: { type: "slabThickness", deltaMm: -2 } },
  { id: "voice", keys: "Mod+Shift+V", does: "Voice commands on / off", group: "Advanced", match: (e, m) => m && !!e.shiftKey && !e.altKey && keyIs(e, "v"), action: { type: "voice" } },
  { id: "help", keys: "F1", alt: ["Shift+?"], does: "Keyboard and mouse shortcuts", group: "Advanced", match: (e) => e.key === "F1" || e.key === "?", action: { type: "help" } },
];

/**
 * The desktop command table for the bindings engine: every row with an id
 * (its default keys = the RadiAnt keyboard preset) plus the shared mouse rows
 * (right drag W/L, middle drag pan, Ctrl+right drag zoom, wheel scroll,
 * Ctrl+wheel slab / zoom, Mouse 4 / 5 previous / next series).
 */
export const DESKTOP_COMMANDS: BindingTable = withMouseCommands(
  BINDINGS.filter((b) => b.id).map(
    (b): BindingCommand => ({ id: b.id!, label: b.does, group: b.group, kind: "action", defaults: [b.keys, ...(b.alt ?? [])] })
  )
);

/** Reader re-mappings: command id → its inputs (deltas over the preset). */
export type ShortcutOverrides = BindingOverrides;

const BY_ID = new Map(BINDINGS.filter((b) => b.id).map((b) => [b.id!, b]));

/** The action a command id runs (keyboard rows; mouse rows have none). */
export function actionForCommand(id: string): ShortcutAction | undefined {
  return BY_ID.get(id)?.action;
}

let cachedIndex: { overrides: BindingOverrides; index: Map<string, string> } | null = null;
function indexFor(overrides: BindingOverrides): Map<string, string> {
  if (cachedIndex?.overrides !== overrides) cachedIndex = { overrides, index: inputIndex(DESKTOP_COMMANDS, overrides) };
  return cachedIndex.index;
}

/**
 * A mouse click, extra button or wheel tilt (any spec) → the action it is
 * bound to. Keys go through resolveShortcut (lenient default matching).
 */
export function resolveInput(spec: string, overrides: BindingOverrides = getLiveBindings()): ShortcutAction | null {
  const id = indexFor(overrides).get(normalizeSpec(spec));
  return (id && actionForCommand(id)) || null;
}

const keyInputs = (specs: readonly string[]) => specs.filter((s) => inputKind(s) === "key");

/** Rows whose default matcher claims a spec (ranges like "Shift+1 … 7" included). */
function reservedBy(spec: string, overrides: BindingOverrides, mac: boolean): BindingCommand | null {
  const probe = specToEvent(spec, mac);
  if (!probe) return null;
  const hit = BINDINGS.find((b) => !(b.id && isCustomised(overrides, b.id)) && b.match(probe, mac ? !!probe.metaKey : !!probe.ctrlKey));
  if (!hit) return null;
  return { id: hit.id ?? `range:${hit.keys}`, label: hit.does, group: hit.group, kind: "action", defaults: [] };
}

/** The key shown for an action (the reader's re-mapping wins), e.g. "Shift+4". */
export function keysForAction(action: ShortcutAction, overrides: ShortcutOverrides = getLiveBindings(), mac = isMac()): string | undefined {
  // Ranges share one display row ("1 … 9", "Shift+1 … 7"): name the one key.
  if (action.type === "preset") return action.ordinal >= 1 && action.ordinal <= 9 ? String(action.ordinal) : undefined;
  if (action.type === "layout") {
    const i = LAYOUT_SHORTCUTS.findIndex((l) => l.rows === action.rows && l.cols === action.cols);
    return i >= 0 ? keyLabel(`Shift+${i + 1}`, mac) : undefined;
  }
  const want = JSON.stringify(action);
  const b = BINDINGS.find((x) => x.id && JSON.stringify(x.action) === want);
  if (!b) return undefined;
  const inputs = effectiveInputs(DESKTOP_COMMANDS, overrides).get(b.id!) ?? [];
  const first = keyInputs(inputs)[0] ?? inputs[0];
  return first ? inputLabel(first, mac) : undefined;
}

/** "Mod+Shift+O" style specs for aria-keyshortcuts (keys only, space separated). */
export function ariaKeysForAction(action: ShortcutAction, overrides: ShortcutOverrides = getLiveBindings(), mac = isMac()): string | undefined {
  const want = JSON.stringify(action);
  const b = BINDINGS.find((x) => x.id && JSON.stringify(x.action) === want);
  if (!b) return undefined;
  const keys = keyInputs(effectiveInputs(DESKTOP_COMMANDS, overrides).get(b.id!) ?? []);
  return keys.length ? keys.map((k) => k.replace(/Mod\+/g, mac ? "Meta+" : "Control+")).join(" ") : undefined;
}

/**
 * Every key that selects a left-button tool, for tooltips and menus: "M / L"
 * for Length, "S" for the rectangle ROI. Read from the bindings (re-mappings
 * win), so a moved key can never leave a stale tooltip behind.
 */
export function toolKeyLabel(tool: string, overrides: ShortcutOverrides = getLiveBindings(), mac = isMac()): string | undefined {
  const eff = effectiveInputs(DESKTOP_COMMANDS, overrides);
  const keys = BINDINGS.filter((b) => b.id && b.action.type === "tool" && b.action.tool === tool).flatMap((b) =>
    keyInputs(eff.get(b.id!) ?? []).map((s) => inputLabel(s, mac))
  );
  return keys.length ? keys.join(" / ") : undefined;
}

/** Bindings the reader can re-map, in sheet order. */
export function remappableBindings(): Binding[] {
  return BINDINGS.filter((b) => b.id);
}

/** Another binding already using `spec` (default or re-mapped), if any. */
export function conflictFor(spec: string, id: string, overrides: ShortcutOverrides = {}, mac = isMac()): Binding | null {
  const hit = findConflict(DESKTOP_COMMANDS, overrides, id, spec, (s) => reservedBy(s, overrides, mac));
  if (!hit) return null;
  return BY_ID.get(hit.id) ?? BINDINGS.find((b) => !b.id && `range:${b.keys}` === hit.id) ?? null;
}

function specToEvent(spec: string, mac: boolean): (Required<Pick<KeyLike, "key">> & KeyLike) | null {
  if (inputKind(spec) !== "key") return null;
  const parts = spec.split("+");
  const key = parts.pop();
  if (!key) return null;
  const has = (p: string) => parts.includes(p);
  const single = key.length === 1;
  return {
    key: single ? key.toLowerCase() : key === "Space" ? " " : key,
    code: /^[0-9]$/.test(key) ? `Digit${key}` : /^[A-Z]$/i.test(key) ? `Key${key.toUpperCase()}` : undefined,
    ctrlKey: mac ? has("Ctrl") : has("Mod"),
    metaKey: mac && has("Mod"),
    altKey: has("Alt"),
    shiftKey: has("Shift"),
  };
}

/** Resolve a key event to an action. `mac` decides whether ⌘ or Ctrl is "Mod". */
export function resolveShortcut(e: KeyLike, mac = isMac(), overrides: ShortcutOverrides = getLiveBindings()): ShortcutAction | null {
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;
  // Copy explicitly: a DOM KeyboardEvent's fields are prototype getters, so a
  // spread (`{ ...e }`) would silently drop code/shift/alt/ctrl/meta.
  const event = {
    key: e.key ?? "",
    code: e.code,
    shiftKey: !!e.shiftKey,
    altKey: !!e.altKey,
    ctrlKey: !!e.ctrlKey,
    metaKey: !!e.metaKey,
  };
  // A re-mapped key wins, and a re-mapped command no longer answers to its defaults.
  const spec = keySpecOf(event, mac);
  const customised = Object.keys(overrides).length > 0;
  if (spec && customised) {
    const id = indexFor(overrides).get(normalizeSpec(spec));
    if (id && isCustomised(overrides, id)) return actionForCommand(id) ?? null;
    // The key was taken from a default row by an override elsewhere.
    for (const [owner, specs] of Object.entries(overrides)) {
      if (specs.some((s) => sameSpec(s, spec)) && owner !== id) return actionForCommand(owner) ?? null;
    }
  }
  for (const binding of BINDINGS) {
    if (binding.id && isCustomised(overrides, binding.id)) continue;
    if (!binding.match(event, mod)) continue;
    // A default key an override has claimed belongs to that override now.
    if (customised && spec && binding.id) {
      const owner = indexFor(overrides).get(normalizeSpec(spec));
      if (owner && owner !== binding.id && isCustomised(overrides, owner)) continue;
    }
    const action = binding.action;
    if (action.type === "preset") return { type: "preset", ordinal: digit(event) };
    if (action.type === "layout") return { type: "layout", ...LAYOUT_SHORTCUTS[digit(event) - 1] };
    return action;
  }
  return null;
}

export interface SheetRow {
  group: Binding["group"];
  keys: string;
  does: string;
  custom: boolean;
  id?: string;
}

/**
 * Commands that only make sense with two or more monitors (a window on the
 * next monitor). The sheet and Settings › Mouse & Keyboard leave them out on a
 * single display; their keys then say so instead of opening a window.
 */
export const MULTI_MONITOR_COMMANDS: ReadonlySet<string> = new Set(["window.sendViewport", "window.sendLayout"]);

const NONE: ReadonlySet<string> = new Set();

/**
 * Rows for the shortcut sheet: every input bound to each command (keys, extra
 * mouse buttons, tilt), in the platform's words. `hidden`: command ids left
 * out (MULTI_MONITOR_COMMANDS on a single display).
 */
export function shortcutSheet(mac = isMac(), overrides: ShortcutOverrides = getLiveBindings(), hidden: ReadonlySet<string> = NONE): SheetRow[] {
  const eff = effectiveInputs(DESKTOP_COMMANDS, overrides);
  const rows: SheetRow[] = [];
  for (const b of BINDINGS) {
    if (!b.keys || (b.id && hidden.has(b.id))) continue;
    if (!b.id) {
      rows.push({ group: b.group, does: b.does, keys: keyLabel(b.keys, mac), custom: false });
      continue;
    }
    const inputs = eff.get(b.id) ?? [];
    if (!inputs.length) continue;
    rows.push({ group: b.group, does: b.does, keys: inputs.map((s) => inputLabel(s, mac)).join(" / "), custom: isCustomised(overrides, b.id), id: b.id });
  }
  return rows;
}
