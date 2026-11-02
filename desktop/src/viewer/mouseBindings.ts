// Mouse gestures for every desktop viewport (native and JS), the toolbar
// tooltips and the F1 sheet. A thin adapter over the shared bindings engine
// (@flowrad/viewer-core/bindings, docs/BINDINGS_DESIGN.md): the RadiAnt preset
// layered with the reader's overrides from Settings › Mouse & Keyboard, read
// live, so a rebind applies to every viewport at once and the sheet can never
// disagree with the hands (HP 0.8.1: the sheet said "right drag = window/
// level", native zoomed).

import {
  DRAG_COMMANDS,
  dragRules,
  dragToolFor,
  effectiveInputs,
  getLiveBindings,
  inputKind,
  inputLabel,
  isMac,
  keyLabel,
  liveBindingsVersion,
  wheelActionFor,
  wheelRules,
  type BindingOverrides,
  type DragRule,
  type WheelAction,
  type WheelRule,
} from "@flowrad/viewer-core/bindings";
import { DESKTOP_COMMANDS } from "../shortcuts";

export interface MouseMods {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** A drag gesture → a navigation tool (button 0 drags the selected tool). */
export interface MouseBinding {
  /** PointerEvent.button: 1 middle, 2 right, 3 / 4 back / forward, 5+ extra. */
  button: number;
  gesture: "drag";
  mods: MouseMods;
  command: "WindowLevel" | "Pan" | "Zoom" | "StackScroll";
}

export interface WheelBinding {
  mods: MouseMods;
  command: WheelAction;
}

const toMods = (m: DragRule["mods"]): MouseMods => ({ ...(m.mod && { ctrl: true }), ...(m.shift && { shift: true }), ...(m.alt && { alt: true }) });

let cache: { version: number; overrides: BindingOverrides; drags: DragRule[]; wheels: WheelRule[] } | null = null;
function rules(overrides?: BindingOverrides) {
  if (overrides) return { drags: dragRules(DESKTOP_COMMANDS, overrides), wheels: wheelRules(DESKTOP_COMMANDS, overrides) };
  const v = liveBindingsVersion();
  if (!cache || cache.version !== v) {
    const o = getLiveBindings();
    cache = { version: v, overrides: o, drags: dragRules(DESKTOP_COMMANDS, o), wheels: wheelRules(DESKTOP_COMMANDS, o) };
  }
  return cache;
}

/** The effective drag bindings (most specific first). */
export function mouseBindings(overrides?: BindingOverrides): MouseBinding[] {
  return rules(overrides).drags.map((r) => ({ button: r.button, gesture: "drag", mods: toMods(r.mods), command: r.tool }));
}

/** The effective wheel bindings (most specific first). */
export function wheelBindings(overrides?: BindingOverrides): WheelBinding[] {
  return rules(overrides).wheels.map((r) => ({ mods: toMods(r.mods), command: r.action }));
}

const asEvent = (m: MouseMods) => ({ ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt });

/** The binding a drag with this button + modifiers fires, if any. */
export function resolveMouse(button: number, mods: MouseMods = {}, overrides?: BindingOverrides): MouseBinding["command"] | undefined {
  return dragToolFor(rules(overrides).drags, button, asEvent(mods));
}

export function resolveWheel(mods: MouseMods = {}, overrides?: BindingOverrides): WheelBinding | undefined {
  const command = wheelActionFor(rules(overrides).wheels, asEvent(mods));
  return command ? { mods, command } : undefined;
}

/**
 * The tool a drag drives: left = the selected tool; another button = the
 * drag tool bound to it, or "" (no drag) when it has none, so an extra
 * button's click stays free for the command bound to it.
 */
export function dragModeFor(button: number, leftTool: string, mods: MouseMods = {}, overrides?: BindingOverrides): string {
  if (button === 0) return leftTool;
  return resolveMouse(button, mods, overrides) ?? "";
}

/** Tooltip suffix for a tool ("Right drag"), from its plain binding if it has one. */
export function mouseHintFor(tool: string, overrides: BindingOverrides = getLiveBindings(), mac = isMac()): string | undefined {
  const id = Object.keys(DRAG_COMMANDS).find((k) => DRAG_COMMANDS[k] === tool);
  if (!id) return undefined;
  const drags = (effectiveInputs(DESKTOP_COMMANDS, overrides).get(id) ?? []).filter((s) => inputKind(s) === "drag");
  const best = drags.find((s) => !s.includes("+")) ?? drags[0];
  return best ? inputLabel(best, mac) : undefined;
}

const WHEEL_WORDS: Record<WheelAction, string> = { scroll: "scroll", zoom: "zoom", slab: "zoom (slab thickness in a reformat)" };
const DRAG_WORDS: Record<string, string> = { WindowLevel: "window/level", Pan: "pan", Zoom: "zoom", StackScroll: "browse slices" };

/** The F1 sheet's mouse line, from the effective bindings. */
export function mouseSheetLine(overrides: BindingOverrides = getLiveBindings(), mac = isMac()): string {
  const eff = effectiveInputs(DESKTOP_COMMANDS, overrides);
  const parts: string[] = ["Mouse: left = selected tool"];
  for (const [id, specs] of eff) {
    const tool = DRAG_COMMANDS[id];
    for (const s of specs) {
      const kind = inputKind(s);
      if (kind === "drag" && tool) parts.push(`${inputLabel(s, mac)} = ${DRAG_WORDS[tool]}`);
    }
  }
  for (const w of wheelBindings(overrides)) {
    const mods = keyLabel(`${w.mods.ctrl ? "Mod+" : ""}${w.mods.alt ? "Alt+" : ""}${w.mods.shift ? "Shift+" : ""}`, mac);
    parts.push(`${mods}wheel = ${WHEEL_WORDS[w.command]}`);
  }
  parts.push("right click = image menu", "Shift+click = 3D cursor.");
  return parts.join(" · ");
}
