// The mouse half of the RadiAnt-style preset, shared by the desktop app and
// the web viewer. Left button = the selected tool (not rebindable); right
// click = the image menu; everything else is a command the reader can move.

import type { BindingCommand, BindingOverrides, BindingTable } from "./map";
import { effectiveInputs } from "./map";
import { mouseButtonOf, parseSpec, type ModState } from "./inputs";

/** Drag tools a mouse button can drive (engine tool names). */
export type DragTool = "WindowLevel" | "Pan" | "Zoom" | "StackScroll";
/** What the vertical wheel can do. */
export type WheelAction = "scroll" | "zoom" | "slab";

export const DRAG_COMMANDS: Record<string, DragTool> = {
  "drag.windowLevel": "WindowLevel",
  "drag.pan": "Pan",
  "drag.zoom": "Zoom",
  "drag.scroll": "StackScroll",
};

export const WHEEL_COMMANDS: Record<string, WheelAction> = {
  "wheel.scroll": "scroll",
  "wheel.zoom": "zoom",
  "wheel.slab": "slab",
};

/**
 * RadiAnt preset, mouse rows: right drag W/L, Ctrl+right drag zoom, middle
 * drag pan, wheel scroll, Ctrl+wheel slab thickness (zoom on a plain image),
 * Mouse 4 / 5 previous / next series.
 */
export const MOUSE_COMMANDS: BindingTable = [
  { id: "drag.windowLevel", label: "Window / level", group: "Mouse", kind: "drag", defaults: ["Mouse2Drag"] },
  { id: "drag.zoom", label: "Zoom", group: "Mouse", kind: "drag", defaults: ["Mod+Mouse2Drag"] },
  { id: "drag.pan", label: "Pan", group: "Mouse", kind: "drag", defaults: ["Mouse1Drag"] },
  { id: "drag.scroll", label: "Browse slices", group: "Mouse", kind: "drag", defaults: [] },
  { id: "wheel.scroll", label: "Scroll images", group: "Mouse", kind: "wheel", defaults: ["Wheel"] },
  { id: "wheel.slab", label: "Zoom (slab thickness in a reformat)", group: "Mouse", kind: "wheel", defaults: ["Mod+Wheel"] },
  { id: "wheel.zoom", label: "Zoom", group: "Mouse", kind: "wheel", defaults: [] },
];

/** Default mouse inputs for one-shot commands, merged into each surface's table. */
export const MOUSE_ACTION_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  "series.prev": ["Mouse3"],
  "series.next": ["Mouse4"],
};

/** The whole shared preset (mouse rows + mouse action defaults), by command id. */
export const RADIANT_PRESET: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(MOUSE_COMMANDS.map((c) => [c.id, c.defaults])),
  ...MOUSE_ACTION_DEFAULTS,
};

/** A surface's action commands + the shared mouse rows, with mouse defaults merged in. */
export function withMouseCommands(actions: readonly BindingCommand[]): BindingTable {
  const merged = actions.map((c) =>
    MOUSE_ACTION_DEFAULTS[c.id] ? { ...c, defaults: [...c.defaults, ...MOUSE_ACTION_DEFAULTS[c.id]] } : c
  );
  return [...merged, ...MOUSE_COMMANDS];
}

export interface DragRule {
  button: number;
  mods: { mod: boolean; alt: boolean; shift: boolean };
  tool: DragTool;
}

export interface WheelRule {
  mods: { mod: boolean; alt: boolean; shift: boolean };
  action: WheelAction;
}

function modsOfSpec(spec: string) {
  const { mods } = parseSpec(spec);
  return { mod: mods.has("Mod"), alt: mods.has("Alt"), shift: mods.has("Shift") };
}

/** Effective drag rules, most specific (most modifiers) first. */
export function dragRules(table: BindingTable, overrides: BindingOverrides = {}): DragRule[] {
  const rules: DragRule[] = [];
  for (const [id, specs] of effectiveInputs(table, overrides)) {
    const tool = DRAG_COMMANDS[id];
    if (!tool) continue;
    for (const s of specs) {
      const button = mouseButtonOf(s);
      if (button === null) continue;
      rules.push({ button, mods: modsOfSpec(s), tool });
    }
  }
  const weight = (r: DragRule) => +r.mods.mod + +r.mods.alt + +r.mods.shift;
  return rules.sort((a, b) => weight(b) - weight(a));
}

/** Effective wheel rules, most specific first. */
export function wheelRules(table: BindingTable, overrides: BindingOverrides = {}): WheelRule[] {
  const rules: WheelRule[] = [];
  for (const [id, specs] of effectiveInputs(table, overrides)) {
    const action = WHEEL_COMMANDS[id];
    if (!action) continue;
    for (const s of specs) rules.push({ mods: modsOfSpec(s), action });
  }
  const weight = (r: WheelRule) => +r.mods.mod + +r.mods.alt + +r.mods.shift;
  return rules.sort((a, b) => weight(b) - weight(a));
}

/**
 * The engine's KeyboardBindings name for a rule's modifiers (Cornerstone:
 * Shift, Ctrl, Alt, Meta, ShiftCtrl, ShiftAlt, ShiftMeta, CtrlAlt, AltMeta).
 * "Mod" is ⌘ (Meta) on macOS and Ctrl elsewhere; "" when none is held.
 */
export function engineModifierName(m: { mod?: boolean; alt?: boolean; shift?: boolean }, mac: boolean): string {
  return `${m.shift ? "Shift" : ""}${m.mod && !mac ? "Ctrl" : ""}${m.alt ? "Alt" : ""}${m.mod && mac ? "Meta" : ""}`;
}

function eventMods(e: ModState, mac: boolean) {
  return { mod: mac ? !!e.metaKey : !!e.ctrlKey || !!e.metaKey, alt: !!e.altKey, shift: !!e.shiftKey };
}

const same = (a: DragRule["mods"], b: DragRule["mods"]) => a.mod === b.mod && a.alt === b.alt && a.shift === b.shift;
const plain = (m: DragRule["mods"]) => !m.mod && !m.alt && !m.shift;

/** The tool a drag with `button` + held modifiers drives (exact match, else the plain binding). */
export function dragToolFor(rules: readonly DragRule[], button: number, e: ModState = {}, mac = false): DragTool | undefined {
  const m = eventMods(e, mac);
  return (rules.find((r) => r.button === button && same(r.mods, m)) ?? rules.find((r) => r.button === button && plain(r.mods)))?.tool;
}

/** What the vertical wheel does with these modifiers (exact, else plain, else nothing). */
export function wheelActionFor(rules: readonly WheelRule[], e: ModState = {}, mac = false): WheelAction | undefined {
  const m = eventMods(e, mac);
  return (rules.find((r) => same(r.mods, m)) ?? rules.find((r) => plain(r.mods)))?.action;
}

/** Buttons that have any binding (drag rule or click command): the viewer suppresses their browser default. */
export function boundButtons(table: BindingTable, overrides: BindingOverrides = {}): Set<number> {
  const out = new Set<number>();
  for (const specs of effectiveInputs(table, overrides).values()) {
    for (const s of specs) {
      const b = mouseButtonOf(s);
      if (b !== null) out.add(b);
    }
  }
  return out;
}
