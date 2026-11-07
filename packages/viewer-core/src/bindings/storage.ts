// Persistence and exchange: one versioned JSON shape for the desktop config
// file, the web's localStorage, the account copy, and Import / Export.
//
//   { "format": "flowrad-bindings", "version": 1, "surface": "desktop",
//     "overrides": { "rotate.cw": ["F13"], "drag.zoom": ["Mouse2Drag"] } }

import { isValidSpec, normalizeSpec } from "./inputs";
import { acceptsInput, type BindingOverrides, type BindingTable } from "./map";

export const BINDINGS_FORMAT = "flowrad-bindings";
export const BINDINGS_VERSION = 1;
/** Web, signed out (and the offline copy when signed in). */
export const WEB_BINDINGS_KEY = "flowrad.bindings";

export type BindingSurface = "desktop" | "web";

export interface BindingsFile {
  format: typeof BINDINGS_FORMAT;
  version: typeof BINDINGS_VERSION;
  surface: BindingSurface;
  /** When this copy was written (ISO); the newest copy wins on sync. */
  updatedAt?: string;
  overrides: Record<string, string[]>;
}

export function toBindingsFile(overrides: BindingOverrides, surface: BindingSurface, updatedAt = new Date().toISOString()): BindingsFile {
  return {
    format: BINDINGS_FORMAT,
    version: BINDINGS_VERSION,
    surface,
    updatedAt,
    overrides: Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, [...v]])),
  };
}

/** Export text (pretty JSON). */
export function exportBindings(overrides: BindingOverrides, surface: BindingSurface): string {
  return `${JSON.stringify(toBindingsFile(overrides, surface), null, 2)}\n`;
}

export interface ParsedBindings {
  overrides: Record<string, string[]>;
  /** Entries left out: unknown command ids or inputs that can't drive them. */
  dropped: string[];
  updatedAt?: string;
  surface?: BindingSurface;
}

export class BindingsFileError extends Error {}

/**
 * Validate a bindings file (text or parsed) against a surface's command
 * table. Unknown commands and invalid inputs are dropped and listed, so a
 * file exported from the other surface or a newer version still imports.
 */
export function parseBindings(input: string | unknown, table: BindingTable): ParsedBindings {
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      throw new BindingsFileError("This file isn't valid JSON.");
    }
  }
  if (!data || typeof data !== "object") throw new BindingsFileError("This isn't a FlowRad bindings file.");
  const d = data as Partial<BindingsFile>;
  if (d.format !== BINDINGS_FORMAT) throw new BindingsFileError("This isn't a FlowRad bindings file.");
  if (typeof d.version !== "number" || d.version > BINDINGS_VERSION) {
    throw new BindingsFileError("This bindings file is from a newer FlowRad version.");
  }
  const raw = d.overrides && typeof d.overrides === "object" ? (d.overrides as Record<string, unknown>) : {};
  const commands = new Map(table.map((c) => [c.id, c]));
  const overrides: Record<string, string[]> = {};
  const dropped: string[] = [];
  const taken = new Set<string>();
  for (const [id, value] of Object.entries(raw)) {
    const cmd = commands.get(id);
    if (!cmd || !Array.isArray(value)) {
      dropped.push(id);
      continue;
    }
    const specs: string[] = [];
    for (const s of value) {
      if (!isValidSpec(s) || !acceptsInput(cmd.kind, normalizeSpec(s))) {
        dropped.push(`${id}: ${String(s)}`);
        continue;
      }
      const n = normalizeSpec(s);
      if (taken.has(n)) {
        dropped.push(`${id}: ${n} (bound twice)`);
        continue;
      }
      taken.add(n);
      specs.push(n);
    }
    overrides[id] = specs;
  }
  return {
    overrides,
    dropped,
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : undefined,
    surface: d.surface === "desktop" || d.surface === "web" ? d.surface : undefined,
  };
}

/**
 * Desktop ≤ 0.8.1 kept re-mapped keys as `settings.shortcuts`: { id: spec }.
 * Each becomes a one-input override (the ids are unchanged).
 */
export function migrateShortcutOverrides(old: unknown, table: BindingTable): Record<string, string[]> {
  if (!old || typeof old !== "object") return {};
  const out: Record<string, string[]> = {};
  const ids = new Set(table.map((c) => c.id));
  for (const [id, spec] of Object.entries(old as Record<string, unknown>)) {
    if (ids.has(id) && isValidSpec(spec)) out[id] = [normalizeSpec(spec)];
  }
  return out;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Read the web copy (never throws: private windows, blocked storage). */
export function loadStoredBindings(storage: StorageLike | null | undefined, table: BindingTable, key = WEB_BINDINGS_KEY): ParsedBindings | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    return parseBindings(raw, table);
  } catch {
    return null;
  }
}

export function saveStoredBindings(
  storage: StorageLike | null | undefined,
  overrides: BindingOverrides,
  surface: BindingSurface,
  key = WEB_BINDINGS_KEY,
  updatedAt?: string
): boolean {
  try {
    storage?.setItem(key, JSON.stringify(toBindingsFile(overrides, surface, updatedAt)));
    return !!storage;
  } catch {
    return false;
  }
}

/** Last write wins: the newer of a local and an account copy. */
export function newerBindings(a: ParsedBindings | null, b: ParsedBindings | null): ParsedBindings | null {
  if (!a) return b;
  if (!b) return a;
  return (b.updatedAt ?? "") > (a.updatedAt ?? "") ? b : a;
}
