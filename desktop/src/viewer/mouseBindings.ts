// Default mouse gestures: ONE table read by every viewport (native and JS),
// the toolbar tooltips and the F1 sheet, so they cannot disagree again (HP
// 0.8.1: the sheet said "right drag = window/level", native zoomed).
//
// Shaped for the customisable-bindings follow-up (docs/BINDINGS_DESIGN.md:
// MouseBinding { button, gesture, mods, command }, resolveMouse / resolveWheel):
// that feature layers the reader's overrides over MOUSE_DEFAULTS and
// WHEEL_DEFAULTS without touching the call sites.
//
// The JS engine binds the same buttons in engine.ts (MouseBindings.Secondary →
// WindowLevel, Auxiliary → Pan); desktop.test.ts checks it against this table.

export interface MouseMods {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** A drag gesture → a navigation tool. Button 0 drags the selected tool. */
export interface MouseBinding {
  /** PointerEvent.button: 1 middle, 2 right (3 / 4 back / forward). */
  button: number;
  gesture: "drag";
  mods: MouseMods;
  command: "WindowLevel" | "Pan" | "Zoom";
  /** For the F1 sheet / tooltips. */
  label: string;
}

export interface WheelBinding {
  mods: MouseMods;
  command: "scroll" | "slab" | "zoom";
  label: string;
}

/** Most specific first: Ctrl+right before right. */
export const MOUSE_DEFAULTS: readonly MouseBinding[] = [
  { button: 2, gesture: "drag", mods: { ctrl: true }, command: "Zoom", label: "zoom" },
  { button: 2, gesture: "drag", mods: {}, command: "WindowLevel", label: "window/level" },
  { button: 1, gesture: "drag", mods: {}, command: "Pan", label: "pan" },
];

/** Ctrl+wheel: slab thickness in a reformat / MPR, zoom on a plain image. */
export const WHEEL_DEFAULTS: readonly WheelBinding[] = [
  { mods: { ctrl: true }, command: "slab", label: "zoom (slab thickness in a reformat)" },
  { mods: {}, command: "scroll", label: "scroll" },
];

const modsMatch = (want: MouseMods, got: MouseMods) =>
  !!want.ctrl === !!got.ctrl && !!want.shift === !!got.shift && !!want.alt === !!got.alt;

/** The binding a drag with this button + modifiers fires, if any. */
export function resolveMouse(button: number, gesture: "drag", mods: MouseMods = {}, table: readonly MouseBinding[] = MOUSE_DEFAULTS): MouseBinding | undefined {
  // An exact modifier match wins; otherwise the button's plain binding.
  return (
    table.find((b) => b.button === button && b.gesture === gesture && modsMatch(b.mods, mods)) ??
    table.find((b) => b.button === button && b.gesture === gesture && !b.mods.ctrl && !b.mods.shift && !b.mods.alt)
  );
}

export function resolveWheel(mods: MouseMods = {}, table: readonly WheelBinding[] = WHEEL_DEFAULTS): WheelBinding | undefined {
  return table.find((b) => modsMatch(b.mods, mods)) ?? table.find((b) => !b.mods.ctrl && !b.mods.shift && !b.mods.alt);
}

/** The tool a drag drives: a bound button's command, else (left) the selected tool. */
export function dragModeFor(button: number, leftTool: string, mods: MouseMods = {}): string {
  if (button === 0) return leftTool;
  return resolveMouse(button, "drag", mods)?.command ?? leftTool;
}

const BUTTON_WORDS: Record<number, string> = { 1: "middle", 2: "right", 3: "back", 4: "forward" };

function gestureWords(b: MouseBinding, modWord: (m: MouseMods) => string): string {
  return `${modWord(b.mods)}${BUTTON_WORDS[b.button] ?? `button ${b.button}`} drag`;
}

const plainMods = (m: MouseMods) => `${m.ctrl ? "Ctrl+" : ""}${m.alt ? "Alt+" : ""}${m.shift ? "Shift+" : ""}`;

/** Tooltip suffix for a tool ("right drag"), from its plain (unmodified) binding. */
export function mouseHintFor(tool: string, modWord: (m: MouseMods) => string = plainMods): string | undefined {
  const b = MOUSE_DEFAULTS.find((x) => x.command === tool && !x.mods.ctrl && !x.mods.shift && !x.mods.alt) ?? MOUSE_DEFAULTS.find((x) => x.command === tool);
  return b ? gestureWords(b, modWord) : undefined;
}

/** The F1 sheet's mouse line; `modWord` renders modifiers ("Ctrl+" / "⌘"). */
export function mouseSheetLine(modWord: (m: MouseMods) => string = plainMods): string {
  const wheel = WHEEL_DEFAULTS.map((w) => `${modWord(w.mods)}wheel = ${w.label}`).reverse();
  const drags = MOUSE_DEFAULTS.map((b) => `${gestureWords(b, modWord)} = ${b.label}`).reverse();
  return ["Mouse: left = selected tool", ...wheel, ...drags, "right click = image menu", "Shift+click = 3D cursor."].join(" · ");
}
