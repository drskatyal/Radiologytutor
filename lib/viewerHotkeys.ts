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
import type { OrientationCommand } from "@flowrad/viewer-core";
import {
  effectiveInputs,
  getLiveBindings,
  inputIndex,
  inputKind,
  inputLabel,
  isCustomised,
  isMac,
  keySpecOf,
  normalizeSpec,
  withMouseCommands,
  type BindingCommand,
  type BindingOverrides,
  type BindingTable,
} from "@flowrad/viewer-core/bindings";

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
  | { type: "orient"; command: OrientationCommand }
  /** Previous / next series (Mouse 4 / 5 by default; any key the reader binds). */
  | { type: "series"; delta: 1 | -1 }
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
  /**
   * R / Shift+R rotate. Off by default because R is the student session's
   * exam-mode "reveal"; the standalone viewer turns it on (with `?`).
   */
  rotateKey?: boolean;
  /**
   * D = Bidirectional. Only where the viewer offers the free viewer's extra
   * measure tools (READING_MEASURE_TOOLS).
   */
  readingTools?: boolean;
}

/** What the host viewer can do beyond the shared keys (shapes the help sheet). */
export interface ShortcutSheetOptions {
  /** The grid can maximise a pane (the free viewer's layouts). */
  paneMaximize?: boolean;
  /** The free viewer's extra measure tools (D = Bidirectional). */
  readingTools?: boolean;
}

/** Commands that exist only where `readingTools` is on. */
const READING_TOOL_COMMANDS = new Set(["tool.bidirectional", "tool.cobb", "tool.circle", "tool.freehand", "tool.magnify"]);

/**
 * Letter → left-button tool, the mnemonic a PACS user already has. None of
 * these is a student-session key (C N P R T F [ Space ?). R (rotate) is bound
 * only where no session owns it (`rotateKey`).
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

/**
 * The web viewer's commands for the bindings engine (docs/BINDINGS_DESIGN.md):
 * each with its default keys (this surface's preset — the student session
 * owns C N P R T F [ Space ?, so the web keys differ from the desktop's) and
 * the action it runs. The shared mouse rows (right drag W/L, middle drag pan,
 * Ctrl+right drag zoom, wheel scroll, Mouse 4 / 5 series) are appended.
 */
interface WebCommand extends BindingCommand {
  action: ViewerHotkeyAction;
}

const cmd = (id: string, label: string, group: string, defaults: string[], action: ViewerHotkeyAction): WebCommand => ({
  id,
  label,
  group,
  kind: "action",
  defaults,
  action,
});

const WEB_ACTIONS: WebCommand[] = [
  cmd("tool.scroll", "Scroll", "Tools", ["S"], { type: "tool", tool: "StackScroll" }),
  cmd("tool.wl", "Window / level", "Tools", ["W"], { type: "tool", tool: "WindowLevel" }),
  cmd("tool.zoom", "Zoom", "Tools", ["Z"], { type: "tool", tool: "Zoom" }),
  cmd("tool.pan", "Pan", "Tools", ["M"], { type: "tool", tool: "Pan" }),
  cmd("tool.length", "Length", "Tools", ["L"], { type: "tool", tool: "Length" }),
  cmd("tool.angle", "Angle", "Tools", ["A"], { type: "tool", tool: "Angle" }),
  cmd("tool.ellipse", "Ellipse ROI", "Tools", ["E"], { type: "tool", tool: "EllipticalROI" }),
  cmd("tool.rect", "Rectangle ROI", "Tools", ["B"], { type: "tool", tool: "RectangleROI" }),
  // The free viewer's extra measure tools (READING_MEASURE_TOOLS). Only
  // Bidirectional has a default key (D, as on the desktop): the desktop's C
  // and N belong to the student session here. The rest can be bound in
  // Settings › Mouse & Keyboard.
  cmd("tool.bidirectional", "Bidirectional", "Tools", ["D"], { type: "tool", tool: "Bidirectional" }),
  cmd("tool.cobb", "Cobb angle", "Tools", [], { type: "tool", tool: "CobbAngle" }),
  cmd("tool.circle", "Circle ROI", "Tools", [], { type: "tool", tool: "CircleROI" }),
  cmd("tool.freehand", "Freehand ROI", "Tools", [], { type: "tool", tool: "PlanarFreehandROI" }),
  cmd("tool.magnify", "Magnifying glass", "Tools", [], { type: "tool", tool: "Magnify" }),
  cmd("slice.prev", "Previous image", "Stack", ["ArrowUp", "ArrowLeft"], { type: "slice", delta: -1 }),
  cmd("slice.next", "Next image", "Stack", ["ArrowDown", "ArrowRight"], { type: "slice", delta: 1 }),
  cmd("slice.first", "First image", "Stack", ["Home"], { type: "sliceAbsolute", where: "first" }),
  cmd("slice.last", "Last image", "Stack", ["End"], { type: "sliceAbsolute", where: "last" }),
  cmd("series.prev", "Previous series", "Stack", [], { type: "series", delta: -1 }),
  cmd("series.next", "Next series", "Stack", [], { type: "series", delta: 1 }),
  cmd("cine", "Play / pause cine", "Stack", ["K"], { type: "cine" }),
  cmd("cine.slower", "Cine slower", "Stack", [","], { type: "cineFps", delta: -1 }),
  cmd("cine.faster", "Cine faster", "Stack", ["."], { type: "cineFps", delta: 1 }),
  // Number keys are window presets, as on the desktop viewer (key n = the
  // preset menu's entry n; Shift+n still works for older muscle memory).
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => cmd(`preset.${n}`, `Window preset ${n}`, "Display", [`${n}`, `Shift+${n}`], { type: "preset", ordinal: n })),
  cmd("preset.default", "Series default window", "Display", ["0", "Shift+0"], { type: "preset", ordinal: 0 }),
  cmd("invert", "Invert", "Display", ["I"], { type: "invert" }),
  cmd("zoom.in", "Zoom in", "Display", ["=", "Shift+="], { type: "zoom", factor: 1.25 }),
  cmd("zoom.out", "Zoom out", "Display", ["-"], { type: "zoom", factor: 1 / 1.25 }),
  cmd("reset", "Reset view", "Display", ["Backspace"], { type: "reset" }),
  cmd("overlay", "Overlay: full → basic → off", "Display", ["O"], { type: "overlay" }),
  cmd("rotate.cw", "Rotate 90° clockwise", "Rotate / flip", ["R"], { type: "orient", command: "rotate:90" }),
  cmd("rotate.ccw", "Rotate 90° anticlockwise", "Rotate / flip", ["Shift+R"], { type: "orient", command: "rotate:-90" }),
  cmd("flip.h", "Flip horizontal", "Rotate / flip", ["H"], { type: "orient", command: "flip:h" }),
  cmd("flip.v", "Flip vertical", "Rotate / flip", ["V"], { type: "orient", command: "flip:v" }),
  cmd("mpr", "Stack ↔ MPR", "Layout", ["X"], { type: "mpr" }),
  cmd("layout", "Cycle hanging layout (where offered)", "Layout", ["G"], { type: "layout" }),
  cmd("help", "This sheet", "Layout", ["Shift+?"], { type: "help" }),
];

/** The web viewer's command table: its keyboard preset + the shared mouse rows. */
export const WEB_COMMANDS: BindingTable = withMouseCommands(WEB_ACTIONS);

const ACTION_BY_ID = new Map(WEB_ACTIONS.map((c) => [c.id, c.action]));
const sameAction = (a: ViewerHotkeyAction, b: ViewerHotkeyAction) => JSON.stringify(a) === JSON.stringify(b);

/** The action a command runs (keys, mouse buttons and tilt all resolve here). */
export function viewerActionForCommand(id: string): ViewerHotkeyAction | undefined {
  return ACTION_BY_ID.get(id);
}

/** The command a default resolution belongs to (so a re-mapped command stops answering to it). */
function commandOfAction(action: ViewerHotkeyAction): string | undefined {
  if (action.type === "slice") return action.delta < 0 ? "slice.prev" : "slice.next";
  return WEB_ACTIONS.find((c) => sameAction(c.action, action))?.id;
}

let cachedIndex: { overrides: BindingOverrides; index: Map<string, string> } | null = null;
function indexFor(overrides: BindingOverrides): Map<string, string> {
  if (cachedIndex?.overrides !== overrides) cachedIndex = { overrides, index: inputIndex(WEB_COMMANDS, overrides) };
  return cachedIndex.index;
}

/** A mouse click / extra button / tilt (any spec) → the action bound to it. */
export function resolveViewerInput(spec: string, overrides: BindingOverrides = getLiveBindings()): ViewerHotkeyAction | null {
  const id = indexFor(overrides).get(normalizeSpec(spec));
  return (id && ACTION_BY_ID.get(id)) || null;
}

const keysOf = (specs: readonly string[]) => specs.filter((s) => inputKind(s) === "key");

/** "1 · S" — the tooltip and help sheet read the bindings, so they cannot drift. */
export function shortcutForTool(tool: string, overrides: BindingOverrides = getLiveBindings(), mac = isMac()): string | null {
  const eff = effectiveInputs(WEB_COMMANDS, overrides);
  const keys = WEB_ACTIONS.filter((c) => c.action.type === "tool" && c.action.tool === tool).flatMap((c) =>
    keysOf(eff.get(c.id) ?? []).map((s) => inputLabel(s, mac))
  );
  return keys.length ? keys.join(" · ") : null;
}

/**
 * The first key bound to window preset `ordinal` (0 = series default): "1",
 * "0", or a reader's own key. Shown on each row of the preset menu.
 */
export function shortcutForPreset(ordinal: number, overrides: BindingOverrides = getLiveBindings(), mac = isMac()): string | null {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 9) return null;
  const id = ordinal === 0 ? "preset.default" : `preset.${ordinal}`;
  const key = keysOf(effectiveInputs(WEB_COMMANDS, overrides).get(id) ?? [])[0];
  return key ? inputLabel(key, mac) : null;
}

export interface ShortcutRow {
  keys: string[];
  does: string;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

const GROUP_TITLES: Record<string, string> = {
  Tools: "Tools (left button · one finger)",
  Stack: "Stack",
  Display: "Display",
  "Rotate / flip": "Rotate / flip",
  Layout: "Layout",
};

/** The help sheet, from the effective bindings (keys, extra mouse buttons and tilt). */
export function viewerShortcutGroups(
  overrides: BindingOverrides = getLiveBindings(),
  mac = isMac(),
  { paneMaximize = false, readingTools = false }: ShortcutSheetOptions = {}
): ShortcutGroup[] {
  const eff = effectiveInputs(WEB_COMMANDS, overrides);
  const groups: ShortcutGroup[] = [];
  for (const c of WEB_ACTIONS) {
    const inputs = eff.get(c.id) ?? [];
    if (!inputs.length) continue;
    if (!readingTools && READING_TOOL_COMMANDS.has(c.id)) continue;
    // The nine presets read as one row by default.
    if (c.id.startsWith("preset.") && c.id !== "preset.default" && !isCustomised(overrides, c.id)) {
      if (c.id !== "preset.1") continue;
      // The free viewer gives Shift+1…7 to layouts, as the desktop does.
      push(groups, c.group, readingTools ? { keys: ["1…9"], does: "Window preset" } : { keys: ["Shift", "1…9"], does: "Window preset" });
      continue;
    }
    push(groups, c.group, { keys: inputs.map((s) => inputLabel(s, mac)), does: c.label });
  }
  push(groups, "Display", { keys: [mac ? "⌘" : "Ctrl", "F11"], does: "Set an exact window (width / level)" });
  if (readingTools) push(groups, "Display", { keys: [mac ? "⌘" : "Ctrl", "E"], does: "Export images, video or anonymised DICOM" });
  if (readingTools) {
    // RadiAnt's reading keys, as on the desktop (@flowrad/viewer-core/readingKeys).
    const mod = mac ? "⌘" : "Ctrl";
    push(groups, "Display", { keys: [mod, "0"], does: "Fit to the pane" });
    push(groups, "Display", { keys: [mod, "= / −"], does: "Zoom in / out a step (the image, not the page)" });
    push(groups, "Display", { keys: [mod, "1…4"], does: "Zoom 100 / 200 / 400 / 800 % (100 % = one image pixel per screen pixel)" });
    push(groups, "Display", { keys: [mod, "Arrows"], does: "Pan the image (a step a press)" });
    push(groups, "Display", { keys: ["F12"], does: "Show / hide annotations" });
    push(groups, "Layout", { keys: [mod, "F12"], does: "Grid: reference lines on / off" });
    push(groups, "Layout", { keys: ["F5"], does: "Grid: link scrolling (Shift+F5 window / level, Alt+F5 zoom and pan)" });
    const alt = mac ? "⌥" : "Alt";
    push(groups, "Layout", { keys: [alt, "A / C / S"], does: "Reformat this pane: axial / coronal / sagittal (again for the stack)" });
    push(groups, "Tools", { keys: ["Shift", "E"], does: "Eraser: click an annotation to delete it" });
    push(groups, "Tools", { keys: ["Y"], does: "Arrow with label" });
    push(groups, "Tools", { keys: ["N"], does: "Freehand ROI" });
    push(groups, "Rotate / flip", { keys: ["Q / Shift+Q"], does: "Rotate 90° (as R / Shift+R)" });
    push(groups, "Layout", { keys: ["Shift", "1…7"], does: "Layout: 1×1 · 1×2 · 2×1 · 2×2 · 1×3 · 2×3 · 3×3" });
    push(groups, "Tools", { keys: [mod, "Shift", "Backspace"], does: "Clear all measurements (Ctrl+Z brings them back)" });
    push(groups, "Stack", { keys: ["Space"], does: "Play / pause cine (as K)" });
    push(groups, "Stack", { keys: ["Shift", "[ / ]"], does: "Cine slower / faster" });
    push(groups, "Stack", { keys: ["[ / ]"], does: "Previous / next series" });
    push(groups, "Display", { keys: [mod, "Shift", "F12"], does: "Overlay text on / off" });
    push(groups, "Rotate / flip", { keys: ["Shift", "Backspace"], does: "Reset rotation and flips (zoom and window kept)" });
    push(groups, "Stack", { keys: ["PageUp / PageDown"], does: "Jump 10 % of the images (also Shift+↑ / ↓)" });
    push(groups, "Layout", { keys: ["F"], does: "Full screen (Esc leaves)" });
    push(groups, "Layout", { keys: ["F1"], does: "This sheet (as Shift+?)" });
    push(groups, "Layout", { keys: [mod, "M"], does: "MPR: three planes (again for the stack)" });
    push(groups, "Layout", { keys: [mod, "Shift", "M"], does: "3D volume rendering (again for the stack)" });
  }
  if (readingTools) push(groups, "Layout", { keys: [mac ? "⌘" : "Ctrl", "Shift", "L"], does: "Grid: link the panes at what each shows now (a prior)" });
  if (readingTools) {
    push(groups, "Display", { keys: ["T"], does: "Slab: thin → MIP → MinIP → AvgIP (reformats the stack's plane)" });
    push(groups, "Display", { keys: [mac ? "⌘" : "Ctrl", "] / ["], does: "Thicker / thinner slab (2 mm steps)" });
  }
  if (readingTools) push(groups, "Layout", { keys: [mac ? "⌥" : "Alt", "Shift", "Enter"], does: "Distraction-free reading: images only (Esc exits)" });
  if (readingTools) push(groups, "Layout", { keys: [mac ? "⌘" : "Ctrl", "Shift", "F"], does: "PET / CT fusion (a study with a CT and a PET)" });
  push(groups, "Layout", { keys: [mac ? "⌘" : "Ctrl", "B"], does: `Show / hide the series panel${mac ? "" : " (⌘B on a Mac)"}` });
  if (paneMaximize) push(groups, "Layout", { keys: ["Enter"], does: "Maximise / restore the outlined pane (or double-click it; Esc restores)" });
  return groups;
}

function push(groups: ShortcutGroup[], group: string, row: ShortcutRow) {
  const title = GROUP_TITLES[group] ?? group;
  let g = groups.find((x) => x.title === title);
  if (!g) groups.push((g = { title, rows: [] }));
  g.rows.push(row);
}

/** Default sheet (static importers: the student cheatsheet). */
export const VIEWER_SHORTCUT_GROUPS: ShortcutGroup[] = viewerShortcutGroups({}, false);

/** Mouse and touch map, shown under the keys, from the effective bindings. */
export function viewerPointerHints(overrides: BindingOverrides = getLiveBindings(), mac = isMac()): ShortcutRow[] {
  const eff = effectiveInputs(WEB_COMMANDS, overrides);
  const rows: ShortcutRow[] = [{ keys: ["Left drag"], does: "Selected tool" }];
  for (const c of WEB_COMMANDS) {
    if (c.kind === "action") continue;
    for (const s of eff.get(c.id) ?? []) rows.push({ keys: [inputLabel(s, mac)], does: c.kind === "wheel" ? (c.id === "wheel.slab" ? "Zoom" : c.label) : c.label });
  }
  rows.push(
    { keys: ["Pinch"], does: "Zoom and pan (touch)" },
    { keys: ["One finger"], does: "Selected tool (touch)" },
    { keys: ["Double-click"], does: "Fit image to the pane" }
  );
  return rows;
}

export const VIEWER_POINTER_HINTS: ShortcutRow[] = viewerPointerHints({}, false);

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
  event: HotkeyEventLike & { code?: string },
  sliceCount: number = 0,
  options: HotkeyOptions = {},
  overrides: BindingOverrides = getLiveBindings()
): ViewerHotkeyAction | null {
  // The reader's own bindings first (Settings › Mouse & Keyboard): any key,
  // F13–F24 and Ctrl+Alt combos from mouse software included.
  if (Object.keys(overrides).length) {
    const spec = keySpecOf({ key: event.key, code: event.code, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey });
    const owner = spec ? indexFor(overrides).get(normalizeSpec(spec)) : undefined;
    if (owner && isCustomised(overrides, owner)) return scaleSlice(ACTION_BY_ID.get(owner) ?? null, sliceCount, event.shiftKey);
    const fallback = defaultViewerHotkey(event, sliceCount, options);
    if (!fallback) return null;
    const id = commandOfAction(fallback);
    // A re-mapped command no longer answers to its default keys.
    if (id && isCustomised(overrides, id)) return null;
    if (owner && owner !== id && isCustomised(overrides, owner)) return null;
    return fallback;
  }
  return defaultViewerHotkey(event, sliceCount, options);
}

/** A bound slice step keeps the Shift = coarse jump of the arrows. */
function scaleSlice(action: ViewerHotkeyAction | null, sliceCount: number, shift?: boolean): ViewerHotkeyAction | null {
  if (!action || action.type !== "slice" || !shift) return action;
  const coarse = Math.max(2, Math.round(Math.max(1, sliceCount) / 20));
  return { type: "slice", delta: action.delta * coarse };
}

/** The web preset's key resolution (lenient: shifted glyphs, Caps Lock). */
function defaultViewerHotkey(event: HotkeyEventLike, sliceCount: number, options: HotkeyOptions): ViewerHotkeyAction | null {
  // Browser and OS combinations stay theirs.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const slice = sliceStepForKey(event.key, sliceCount, { shift: event.shiftKey });
  if (slice !== null) return { type: "slice", delta: slice };

  if (event.key === "Home") return { type: "sliceAbsolute", where: "first" };
  if (event.key === "End") return { type: "sliceAbsolute", where: "last" };

  // A digit (with or without Shift) is a window preset, as on the desktop
  // viewer; 0 is the series' own window ("full dynamic"), ordinal 0.
  if (/^[0-9]$/.test(event.key)) {
    return { type: "preset", ordinal: Number(event.key) };
  }
  // Shift+digit arrives as the shifted glyph on many layouts (! " # …).
  const shifted = "!@#$%^&*(".indexOf(event.key);
  if (shifted >= 0) return { type: "preset", ordinal: shifted + 1 };
  if (event.key === ")") return { type: "preset", ordinal: 0 };

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
    case "Backspace":
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
    case "r":
      return options.rotateKey ? { type: "orient", command: event.shiftKey ? "rotate:-90" : "rotate:90" } : null;
    case "d":
      return options.readingTools ? { type: "tool", tool: "Bidirectional" } : null;
    case "h":
      return { type: "orient", command: "flip:h" };
    case "v":
      return { type: "orient", command: "flip:v" };
    default:
      return null;
  }
}
