// The binding map: a surface's command table (its defaults = the preset)
// layered with the reader's overrides. One source of truth per surface:
// handlers resolve inputs through it, and tooltips, menus, the ? / F1 sheet
// and aria-keyshortcuts render from it.
//
// Overrides are DELTAS by command id: a command named in the overrides uses
// exactly those inputs (an empty list = unbound); every other command keeps
// its preset inputs, minus any input an override has since claimed. New
// preset defaults therefore still reach readers who customised other rows.

import { inputKind, isValidSpec, normalizeSpec, sameSpec, type InputKind } from "./inputs";

/**
 * What a command accepts:
 *  - "action": a one-shot command — keys, mouse clicks (extra buttons
 *    included) and wheel tilt notches can all fire it;
 *  - "drag": a press-and-drag navigation tool (W/L, pan, zoom, browse);
 *  - "wheel": what the vertical wheel does (scroll, zoom, slab).
 */
export type CommandKind = "action" | "drag" | "wheel";

export interface BindingCommand {
  /** Stable id (stored in settings / exported JSON). */
  id: string;
  /** "Rotate 90° clockwise": the Settings row and conflict prompt. */
  label: string;
  /** Settings / sheet grouping ("Tools", "View", "Mouse"…). */
  group: string;
  kind: CommandKind;
  /** The preset's inputs (specs). */
  defaults: readonly string[];
}

export type BindingTable = readonly BindingCommand[];
export type BindingOverrides = Readonly<Record<string, readonly string[]>>;

const KIND_ACCEPTS: Record<CommandKind, readonly InputKind[]> = {
  action: ["key", "click", "tilt"],
  drag: ["drag"],
  wheel: ["wheel"],
};

/** Can `spec` be bound to a command of this kind? */
export function acceptsInput(kind: CommandKind, spec: string): boolean {
  if (!isValidSpec(spec)) return false;
  const k = inputKind(spec);
  if (!KIND_ACCEPTS[kind].includes(k)) return false;
  // The left button is the selected tool and the right click opens the image
  // menu: neither can be taken by a binding.
  if ((k === "click" || k === "drag") && /(^|\+)Mouse0(Drag)?$/.test(spec)) return false;
  if (k === "click" && /(^|\+)Mouse2$/.test(spec)) return false;
  return true;
}

function byId(table: BindingTable): Map<string, BindingCommand> {
  return new Map(table.map((c) => [c.id, c]));
}

/** command id → its effective inputs (normalized), in table order. */
export function effectiveInputs(table: BindingTable, overrides: BindingOverrides = {}): Map<string, string[]> {
  const claimed = new Set<string>();
  for (const c of table) {
    const own = overrides[c.id];
    if (own) for (const s of own) claimed.add(normalizeSpec(s));
  }
  const out = new Map<string, string[]>();
  for (const c of table) {
    const own = overrides[c.id];
    const specs = own
      ? own.map(normalizeSpec)
      : c.defaults.map(normalizeSpec).filter((s) => !claimed.has(s));
    out.set(c.id, [...new Set(specs)]);
  }
  return out;
}

/** input spec → command id. The first command in table order wins a tie. */
export function inputIndex(table: BindingTable, overrides: BindingOverrides = {}): Map<string, string> {
  const index = new Map<string, string>();
  for (const [id, specs] of effectiveInputs(table, overrides)) {
    for (const s of specs) if (!index.has(s)) index.set(s, id);
  }
  return index;
}

/** The command an input fires, if any. */
export function commandFor(index: Map<string, string>, spec: string | null | undefined): string | undefined {
  return spec ? index.get(normalizeSpec(spec)) : undefined;
}

/** The effective inputs of one command. */
export function inputsFor(table: BindingTable, overrides: BindingOverrides, id: string): string[] {
  return effectiveInputs(table, overrides).get(id) ?? [];
}

/**
 * Another command that already holds `spec`, if any. `reserved` lets a
 * surface claim inputs it binds outside the table (ranges such as "1 … 9").
 */
export function findConflict(
  table: BindingTable,
  overrides: BindingOverrides,
  commandId: string,
  spec: string,
  reserved?: (spec: string) => BindingCommand | null
): BindingCommand | null {
  const holder = inputIndex(table, overrides).get(normalizeSpec(spec));
  if (holder && holder !== commandId) return byId(table).get(holder) ?? null;
  if (!holder && reserved) {
    const r = reserved(normalizeSpec(spec));
    if (r && r.id !== commandId) return r;
  }
  return null;
}

export class BindingError extends Error {}

/**
 * Bind `spec` to `commandId` (replacing its inputs, or adding with
 * `mode: "add"`). If another command holds it: `swap` gives that command
 * this command's previous inputs (those of the right kind); otherwise the
 * call refuses with a BindingError naming the holder.
 */
export function assignInput(
  table: BindingTable,
  overrides: BindingOverrides,
  commandId: string,
  spec: string,
  opts: { swap?: boolean; mode?: "replace" | "add"; reserved?: (spec: string) => BindingCommand | null } = {}
): Record<string, string[]> {
  const cmd = byId(table).get(commandId);
  if (!cmd) throw new BindingError(`Unknown command: ${commandId}`);
  const s = normalizeSpec(spec);
  if (!acceptsInput(cmd.kind, s)) throw new BindingError(`That input can't be bound to “${cmd.label}”.`);
  const before = inputsFor(table, overrides, commandId);
  const next: Record<string, string[]> = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, [...v]]));
  const conflict = findConflict(table, overrides, commandId, s, opts.reserved);
  if (conflict) {
    if (!opts.swap) throw new BindingError(`${s} is already “${conflict.label}”.`);
    if (!table.some((c) => c.id === conflict.id)) throw new BindingError(`${s} is fixed to “${conflict.label}”.`);
    const theirs = inputsFor(table, overrides, conflict.id).filter((x) => !sameSpec(x, s));
    const handBack = before.filter((x) => acceptsInput(conflict.kind, x) && !theirs.includes(x));
    next[conflict.id] = [...theirs, ...handBack];
  }
  next[commandId] = opts.mode === "add" ? [...new Set([...before, s])] : [s];
  return tidy(table, next);
}

/** Unbind one input (or all, when `spec` is omitted) from a command. */
export function clearInput(table: BindingTable, overrides: BindingOverrides, commandId: string, spec?: string): Record<string, string[]> {
  const next: Record<string, string[]> = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, [...v]]));
  next[commandId] = spec ? inputsFor(table, overrides, commandId).filter((x) => !sameSpec(x, spec)) : [];
  return tidy(table, next);
}

/** Back to the preset for one command. */
export function resetCommand(table: BindingTable, overrides: BindingOverrides, commandId: string): Record<string, string[]> {
  const next: Record<string, string[]> = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, [...v]]));
  delete next[commandId];
  return tidy(table, next);
}

/** Overrides equal to the preset are dropped, so new defaults keep flowing. */
function tidy(table: BindingTable, overrides: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const ids = byId(table);
  for (const [id, specs] of Object.entries(overrides)) {
    const cmd = ids.get(id);
    if (!cmd) continue;
    const norm = [...new Set(specs.map(normalizeSpec))];
    const def = cmd.defaults.map(normalizeSpec);
    if (norm.length === def.length && norm.every((s, i) => s === def[i])) {
      // Equal to the preset — but only drop it if no other override has claimed
      // one of those defaults (else dropping would silently re-bind it).
      const claimedElsewhere = Object.entries(overrides).some(
        ([other, o]) => other !== id && o.some((x) => def.includes(normalizeSpec(x)))
      );
      if (!claimedElsewhere) continue;
    }
    out[id] = norm;
  }
  return out;
}

/** Is a command bound differently from its preset? */
export function isCustomised(overrides: BindingOverrides, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, id);
}
