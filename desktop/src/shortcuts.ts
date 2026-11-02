// Keyboard map. Pure: KeyboardEvent-like → action, so it is unit-tested and
// the shortcut sheet is generated from the same table (one source of truth).
//
// Tool letters follow RadiAnt where RadiAnt documents one (B, W, M, Z, L, A,
// E, C, Y, P; Ctrl+0…4 zoom; Ctrl+arrows pan; F full screen; Ctrl+E export;
// Ctrl+O / Ctrl+Shift+O / Ctrl+Alt+O open) — a radiologist switching over
// should not have to relearn their hands.

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
  | { type: "toggleBrowser" }
  | { type: "fullscreen" }
  | { type: "distractionFree" }
  | { type: "maximizeCell" }
  | { type: "undoAnnotation" }
  | { type: "redoAnnotation" }
  | { type: "voice" }
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

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface Binding {
  /** Stable id for bindings the reader can re-map in Settings. */
  id?: string;
  /** Display form, e.g. "Ctrl+Shift+O". "Mod" renders as ⌘ on macOS. */
  keys: string;
  does: string;
  group: "Open" | "Tools" | "Navigate" | "Window" | "View" | "Layout" | "Annotate" | "Advanced";
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
  { keys: "Mod+O", does: "Open DICOM files", group: "Open", match: (e, m) => m && !e.shiftKey && !e.altKey && keyIs(e, "o"), action: { type: "open", what: "files" } },
  { keys: "Mod+Shift+O", does: "Open a folder", group: "Open", match: (e, m) => m && !!e.shiftKey && !e.altKey && keyIs(e, "o"), action: { type: "open", what: "folder" } },
  { keys: "Mod+Alt+O", does: "Open CD / DVD / USB", group: "Open", match: (e, m) => m && !!e.altKey && keyIs(e, "o", "ø"), action: { type: "open", what: "disc" } },
  { keys: "Mod+Shift+P", does: "Query / retrieve from a PACS", group: "Open", match: (e, m) => m && !!e.shiftKey && keyIs(e, "p"), action: { type: "open", what: "pacs" } },
  { keys: "Mod+Shift+Z", does: "Open a zip archive", group: "Open", match: (e, m) => m && !!e.shiftKey && keyIs(e, "z"), action: { type: "open", what: "zip" } },

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
  tool("r", "RectangleROI", "Rectangle ROI"),
  tool("o", "CircleROI", "Circle ROI"),
  tool("n", "PlanarFreehandROI", "Freehand ROI"),
  tool("x", "Probe", "Pixel value probe"),
  tool("y", "ArrowAnnotate", "Arrow with label"),
  tool("d", "Bidirectional", "Bidirectional (long / short axis)"),
  tool("g", "Magnify", "Magnifying glass"),

  // Navigate
  { id: "slice.prev", keys: "↑", does: "Previous image", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "ArrowUp"), action: { type: "slice", delta: -1 } },
  { id: "slice.next", keys: "↓", does: "Next image", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "ArrowDown"), action: { type: "slice", delta: 1 } },
  { id: "series.prev", keys: "←", does: "Previous series (active viewport)", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "ArrowLeft"), action: { type: "series", delta: -1 } },
  { id: "series.next", keys: "→", does: "Next series (active viewport)", group: "Navigate", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "ArrowRight"), action: { type: "series", delta: 1 } },
  { id: "page.prev", keys: "PgUp", does: "Jump back 10% of the images", group: "Navigate", match: (e, m) => plain(e, m) && (keyIs(e, "PageUp") || (!!e.shiftKey && keyIs(e, "ArrowUp"))), action: { type: "slicePage", dir: -1 } },
  { id: "page.next", keys: "PgDn", does: "Jump forward 10% of the images", group: "Navigate", match: (e, m) => plain(e, m) && (keyIs(e, "PageDown") || (!!e.shiftKey && keyIs(e, "ArrowDown"))), action: { type: "slicePage", dir: 1 } },
  { id: "slice.first", keys: "Home", does: "First image", group: "Navigate", match: (e, m) => plain(e, m) && keyIs(e, "Home"), action: { type: "sliceEdge", where: "first" } },
  { id: "slice.last", keys: "End", does: "Last image", group: "Navigate", match: (e, m) => plain(e, m) && keyIs(e, "End"), action: { type: "sliceEdge", where: "last" } },
  { keys: "[ / ]", does: "Previous / next series", group: "Navigate", match: (e, m) => plain(e, m) && e.key === "[", action: { type: "series", delta: -1 } },
  { keys: "", does: "", group: "Navigate", match: (e, m) => plain(e, m) && e.key === "]", action: { type: "series", delta: 1 } },
  { keys: "Tab / Shift+Tab", does: "Next / previous series", group: "Navigate", match: (e, m) => plain(e, m) && e.key === "Tab", action: { type: "series", delta: 1 } },
  { keys: "Space", does: "Play / pause cine", group: "Navigate", match: (e, m) => plain(e, m) && e.key === " ", action: { type: "cine" } },
  { keys: "Shift+[ / Shift+]", does: "Cine slower / faster", group: "Navigate", match: (e, m) => plain(e, m) && (e.key === "{" || (!!e.shiftKey && e.key === "[")), action: { type: "cineFps", delta: -5 } },
  { keys: "", does: "", group: "Navigate", match: (e, m) => plain(e, m) && (e.key === "}" || (!!e.shiftKey && e.key === "]")), action: { type: "cineFps", delta: 5 } },

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
  { id: "invert", keys: "I", does: "Invert greyscale", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "i"), action: { type: "invert" } },
  { keys: "H / V", does: "Flip horizontal / vertical", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "h"), action: { type: "flip", axis: "h" } },
  { keys: "", does: "", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "v"), action: { type: "flip", axis: "v" } },
  { keys: "Q / Shift+Q", does: "Rotate 90° right / left", group: "View", match: (e, m) => plain(e, m) && keyIs(e, "q"), action: { type: "rotate", degrees: 90 } },
  { keys: "Esc", does: "Cancel the tool / drawing · leave full screen", group: "View", match: (e) => e.key === "Escape", action: { type: "escape" } },
  { id: "reset", keys: "Backspace", does: "Reset zoom, pan, window, rotation", group: "View", match: (e, m) => plain(e, m) && keyIs(e, "Backspace"), action: { type: "reset" } },
  { keys: "Mod+Shift+F12", does: "Show / hide DICOM overlay", group: "View", match: (e, m) => m && !!e.shiftKey && e.key === "F12", action: { type: "toggleOverlay" } },
  { keys: "F12", does: "Show / hide annotations", group: "View", match: (e, m) => !m && e.key === "F12", action: { type: "toggleAnnotations" } },
  { keys: "F", does: "Full screen", group: "View", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "f"), action: { type: "fullscreen" } },
  { keys: "Shift+Alt+Enter", does: "Distraction-free reading", group: "View", match: (e) => !!e.shiftKey && !!e.altKey && e.key === "Enter", action: { type: "distractionFree" } },
  { keys: "Mod+B", does: "Show / hide series browser", group: "View", match: (e, m) => m && !e.shiftKey && keyIs(e, "b"), action: { type: "toggleBrowser" } },

  // Window
  { keys: "1 … 9", does: "Window presets (by modality)", group: "Window", match: (e, m) => plain(e, m) && !e.shiftKey && digit(e) >= 1 && digit(e) <= 9, action: { type: "preset", ordinal: 1 } },
  { keys: "0", does: "Default window (from the file)", group: "Window", match: (e, m) => plain(e, m) && !e.shiftKey && digit(e) === 0, action: { type: "presetDefault" } },
  { keys: "Mod+F11", does: "Set exact WW / WL", group: "Window", match: (e, m) => m && e.key === "F11", action: { type: "customWindow" } },

  // Layout
  { keys: "Shift+1 … 7", does: "Layouts 1×1 · 1×2 · 2×1 · 2×2 · 1×3 · 2×3 · 3×3", group: "Layout", match: (e, m) => plain(e, m) && !!e.shiftKey && digit(e) >= 1 && digit(e) <= 7, action: { type: "layout", rows: 1, cols: 1 } },
  { keys: "Enter", does: "Maximise / restore the active viewport", group: "Layout", match: (e, m) => plain(e, m) && !e.shiftKey && e.key === "Enter", action: { type: "maximizeCell" } },
  { keys: "F5", does: "Synchronise scrolling (by position)", group: "Layout", match: (e) => e.key === "F5" && !e.shiftKey && !e.altKey, action: { type: "toggleSync" } },
  { id: "sync.voi", keys: "Shift+F5", does: "Synchronise window / level", group: "Layout", match: (e) => e.key === "F5" && !!e.shiftKey && !e.altKey, action: { type: "toggleSyncVoi" } },
  { id: "sync.zoom", keys: "Alt+F5", does: "Synchronise zoom and pan", group: "Layout", match: (e) => e.key === "F5" && !!e.altKey && !e.shiftKey, action: { type: "toggleSyncZoom" } },
  { id: "sync.link", keys: "Mod+Shift+L", does: "Link viewports at what they show now (register a prior / other FOV)", group: "Layout", match: (e, m) => m && !!e.shiftKey && keyIs(e, "l"), action: { type: "linkAtCurrent" } },
  { keys: "Mod+F12", does: "Reference lines", group: "Layout", match: (e, m) => m && !e.shiftKey && e.key === "F12", action: { type: "toggleReferenceLines" } },

  // Annotate
  { keys: "Mod+Z", does: "Undo (measurements, arrows, deletes)", group: "Annotate", match: (e, m) => m && !e.shiftKey && keyIs(e, "z"), action: { type: "undoAnnotation" } },
  { keys: "Mod+Y", does: "Redo", group: "Annotate", match: (e, m) => m && !e.shiftKey && keyIs(e, "y"), action: { type: "redoAnnotation" } },
  { keys: "Del", does: "Delete the selected annotation (click it first)", group: "Annotate", match: () => false, action: { type: "undoAnnotation" } },
  { id: "tool.eraser", keys: "Shift+E", does: "Eraser: click an annotation to delete it", group: "Annotate", match: (e, m) => plain(e, m) && !!e.shiftKey && keyIs(e, "e"), action: { type: "tool", tool: "Eraser" } },
  { keys: "Right-click", does: "Annotation menu: delete, label, copy value, delete all", group: "Annotate", match: () => false, action: { type: "undoAnnotation" } },
  { keys: "Mod+Shift+Delete", does: "Clear measurements", group: "Annotate", match: (e, m) => m && !!e.shiftKey && (keyIs(e, "Delete") || keyIs(e, "Backspace")), action: { type: "clearAnnotations" } },
  { keys: "Mod+E", does: "Export images / video / DICOM", group: "Annotate", match: (e, m) => m && keyIs(e, "e"), action: { type: "export" } },

  // Advanced
  { id: "mpr", keys: "Mod+M", does: "MPR (three planes, crosshairs)", group: "Advanced", match: (e, m) => m && !e.shiftKey && keyIs(e, "m"), action: { type: "mpr" } },
  { id: "volume3d", keys: "Mod+Shift+M", does: "3D volume rendering", group: "Advanced", match: (e, m) => m && !!e.shiftKey && keyIs(e, "m"), action: { type: "volume3d" } },
  { keys: "Mod+Shift+F", does: "PET / CT fusion", group: "Advanced", match: (e, m) => m && !!e.shiftKey && keyIs(e, "f"), action: { type: "fusion" } },
  { id: "reformat.coronal", keys: "Alt+C", does: "Coronal reformat in the active viewport", group: "Advanced", match: (e, m) => !m && !!e.altKey && !e.shiftKey && (e.code === "KeyC" || keyIs(e, "c", "ç")), action: { type: "reformat", plane: "coronal" } },
  { id: "reformat.sagittal", keys: "Alt+S", does: "Sagittal reformat in the active viewport", group: "Advanced", match: (e, m) => !m && !!e.altKey && !e.shiftKey && (e.code === "KeyS" || keyIs(e, "s", "ß")), action: { type: "reformat", plane: "sagittal" } },
  { id: "reformat.axial", keys: "Alt+A", does: "Axial slab in the active viewport", group: "Advanced", match: (e, m) => !m && !!e.altKey && !e.shiftKey && (e.code === "KeyA" || keyIs(e, "a", "å")), action: { type: "reformat", plane: "axial" } },
  { id: "slab.cycle", keys: "T", does: "Slab: Slice → MIP → MinIP → AvgIP", group: "Advanced", match: (e, m) => plain(e, m) && !e.shiftKey && keyIs(e, "t"), action: { type: "slabCycle" } },
  { id: "slab.thicker", keys: "Mod+]", does: "Thicker slab (+2 mm; Ctrl+wheel too)", group: "Advanced", match: (e, m) => m && !e.shiftKey && (e.key === "]" || e.code === "BracketRight"), action: { type: "slabThickness", deltaMm: 2 } },
  { id: "slab.thinner", keys: "Mod+[", does: "Thinner slab (−2 mm)", group: "Advanced", match: (e, m) => m && !e.shiftKey && (e.key === "[" || e.code === "BracketLeft"), action: { type: "slabThickness", deltaMm: -2 } },
  { id: "voice", keys: "Mod+Shift+V", does: "Voice commands on / off", group: "Advanced", match: (e, m) => m && !!e.shiftKey && !e.altKey && keyIs(e, "v"), action: { type: "voice" } },
  { keys: "F1 / ?", does: "Keyboard shortcuts", group: "Advanced", match: (e) => e.key === "F1" || e.key === "?", action: { type: "help" } },
];

/**
 * A shortcut spec ("Mod+Shift+M", "Shift+Q", "Mod+Shift+Backspace") in the
 * platform's words: ⌘ ⇧ ⌥ ⌫ on macOS, "Ctrl+Shift+M" elsewhere. Windows and
 * Linux UI fonts (and native tooltips) lack ⇧/⌥/⌫, which then render as "?".
 */
export function keyLabel(spec: string, mac = isMac()): string {
  return spec
    .replace(/Mod\+/g, mac ? "⌘" : "Ctrl+")
    .replace(/Alt\+/g, mac ? "⌥" : "Alt+")
    .replace(/Shift\+/g, mac ? "⇧" : "Shift+")
    .replace(/Backspace/g, mac ? "⌫" : "Backspace");
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Reader re-mappings from Settings: binding id → key spec ("Mod+Shift+K"). */
export type ShortcutOverrides = Readonly<Record<string, string>>;

const NAMED: Record<string, string> = { " ": "Space", Esc: "Escape", Del: "Delete", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

/** The key part of a spec for an event: "K", "5", "ArrowUp", "F5", "Space", "]". */
function keyToken(e: KeyLike): string | null {
  if (["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock"].includes(e.key)) return null;
  if (e.code?.startsWith("Digit")) return e.code.slice(5);
  if (e.code?.startsWith("Key") && e.code.length === 4) return e.code.slice(3);
  const k = NAMED[e.key] ?? e.key;
  return k.length === 1 ? k.toUpperCase() : k;
}

/**
 * A key event as a spec, for recording a re-mapping in Settings (null while
 * only modifiers are held). "Mod" is ⌘ on macOS and Ctrl elsewhere.
 */
export function keySpecOf(e: KeyLike, mac = isMac()): string | null {
  const key = keyToken(e);
  if (!key) return null;
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;
  return [mod && "Mod", mac && e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", key].filter(Boolean).join("+");
}

/** Does this event press the spec? */
export function matchesSpec(spec: string, e: KeyLike, mac = isMac()): boolean {
  const parts = spec.split("+");
  // "Mod++" style specs are not produced; a trailing "+" key would split empty.
  const key = parts.pop() || "+";
  const want = new Set(parts);
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;
  if (want.has("Mod") !== mod || want.has("Alt") !== !!e.altKey || want.has("Shift") !== !!e.shiftKey) return false;
  if (mac && want.has("Ctrl") !== !!e.ctrlKey) return false;
  return keyToken(e)?.toUpperCase() === key.toUpperCase();
}

/** Bindings the reader can re-map, in sheet order. */
export function remappableBindings(): Binding[] {
  return BINDINGS.filter((b) => b.id && b.keys);
}

/** Another binding already using `spec` (default or re-mapped), if any. */
export function conflictFor(spec: string, id: string, overrides: ShortcutOverrides = {}, mac = isMac()): Binding | null {
  for (const b of BINDINGS) {
    if (b.id === id || !b.keys) continue;
    const current = b.id && overrides[b.id];
    if (current ? current.toUpperCase() === spec.toUpperCase() : b.keys.toUpperCase() === spec.toUpperCase()) return b;
  }
  // Defaults the sheet shows as ranges ("Shift+1 … 7") still claim their keys.
  const probe = specToEvent(spec, mac);
  if (!probe) return null;
  const hit = BINDINGS.find((b) => b.id !== id && !(b.id && overrides[b.id]) && b.match(probe, mac ? !!probe.metaKey : !!probe.ctrlKey));
  return hit ?? null;
}

function specToEvent(spec: string, mac: boolean): (Required<Pick<KeyLike, "key">> & KeyLike) | null {
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
export function resolveShortcut(e: KeyLike, mac = isMac(), overrides: ShortcutOverrides = {}): ShortcutAction | null {
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
  e = event;
  // A re-mapped key wins, and the binding no longer answers to its default.
  for (const binding of BINDINGS) {
    const spec = binding.id && overrides[binding.id];
    if (spec && matchesSpec(spec, event, mac)) return binding.action;
  }
  for (const binding of BINDINGS) {
    if (binding.id && overrides[binding.id]) continue;
    if (!binding.match(event, mod)) continue;
    const action = binding.action;
    if (action.type === "preset") return { type: "preset", ordinal: digit(e) };
    if (action.type === "layout") return { type: "layout", ...LAYOUT_SHORTCUTS[digit(e) - 1] };
    if (action.type === "rotate" && e.shiftKey) return { type: "rotate", degrees: -90 };
    if (action.type === "series" && e.key === "Tab" && e.shiftKey) return { type: "series", delta: -1 };
    return action;
  }
  return null;
}

/** Rows for the shortcut sheet, with Mod rendered for this platform. */
export function shortcutSheet(mac = isMac(), overrides: ShortcutOverrides = {}): { group: Binding["group"]; keys: string; does: string; custom: boolean }[] {
  return BINDINGS.filter((b) => b.keys).map((b) => {
    const custom = b.id ? overrides[b.id] : undefined;
    return { group: b.group, does: b.does, keys: keyLabel(custom ?? b.keys, mac), custom: !!custom };
  });
}
