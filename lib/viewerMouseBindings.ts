// The web viewer's drag / wheel tools from the reader's mouse bindings
// (Settings › Mouse & Keyboard): the shared RadiAnt preset — right drag W/L,
// Ctrl+right drag zoom, middle drag pan, wheel scroll — layered with the
// reader's overrides, as Cornerstone tool-group bindings.
//
// Cornerstone binds mouse buttons 1–4 (middle, right, back, forward) to
// tools; a sixth or higher button can still run any one-shot command (click),
// handled by the viewer's bindings listener rather than the engine.

import {
  dragRules,
  getLiveBindings,
  wheelRules,
  type BindingOverrides,
} from "@flowrad/viewer-core/bindings";
import { WEB_COMMANDS } from "./viewerHotkeys";

export interface EngineEnums {
  MouseBindings: Record<string, number | string>;
  KeyboardBindings: Record<string, number | string>;
}

export interface EngineBinding {
  mouseButton: number;
  modifierKey?: number;
}

/** Engine tool for a wheel action: the web stack has no slab, so Ctrl+wheel zooms. */
const WHEEL_TOOL = { scroll: "StackScroll", zoom: "Zoom", slab: "Zoom" } as const;

function modifierKey(enums: EngineEnums, m: { mod: boolean; alt: boolean; shift: boolean }): number | null | undefined {
  const name = `${m.shift ? "Shift" : ""}${m.mod ? "Ctrl" : ""}${m.alt ? "Alt" : ""}`;
  if (!name) return undefined;
  const v = enums.KeyboardBindings[name];
  return typeof v === "number" ? v : null;
}

/** The engine bindings `tool` holds besides the left button, from the effective mouse bindings. */
export function viewerFixedBindings(enums: EngineEnums, tool: string, overrides: BindingOverrides = getLiveBindings()): EngineBinding[] {
  const mb = enums.MouseBindings as Record<string, number>;
  const button: Record<number, number | undefined> = { 1: mb.Auxiliary, 2: mb.Secondary, 3: mb.Fourth_Button, 4: mb.Fifth_Button };
  const out: EngineBinding[] = [];
  for (const r of dragRules(WEB_COMMANDS, overrides)) {
    if (r.tool !== tool || button[r.button] === undefined) continue;
    const key = modifierKey(enums, r.mods);
    if (key === null) continue; // a combination the engine can't express
    out.push(key === undefined ? { mouseButton: button[r.button]! } : { mouseButton: button[r.button]!, modifierKey: key });
  }
  for (const r of wheelRules(WEB_COMMANDS, overrides)) {
    if (WHEEL_TOOL[r.action] !== tool) continue;
    const key = modifierKey(enums, r.mods);
    if (key === null) continue;
    out.push(key === undefined ? { mouseButton: mb.Wheel } : { mouseButton: mb.Wheel, modifierKey: key });
  }
  return out;
}
