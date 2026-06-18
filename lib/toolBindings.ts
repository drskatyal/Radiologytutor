// Left-mouse (Primary) tool switching for our Cornerstone3D tool group.
//
// Cornerstone's `ToolGroup` has two behaviours that, combined, caused the
// "annotation tools don't draw" bug:
//
//   1. `setToolActive(name, { bindings })` MERGES the new bindings into the
//      tool's existing ones (deduped) and never removes any. So repeatedly
//      activating tools accumulates bindings.
//   2. `getActiveToolForMouseEvent` returns the FIRST tool (in tool-group
//      insertion order) whose Active bindings contain the pressed mouse button.
//
// If we only ever ADD the Primary binding to the newly-selected tool, the
// previously-selected tool keeps its Primary binding too, and because it sits
// earlier in iteration order it keeps winning the left button — the new tool is
// "active" but never receives mousedown. Manipulation tools (Pan/Zoom/Scroll)
// hid the bug because they also own wheel/right/middle.
//
// The fix: exactly one tool owns the Primary binding at a time. On switch we
// strip the Primary binding from the outgoing tool, then add it to the incoming
// one. This module is a tiny, dependency-free model of that so it can be unit
// tested without the WebGL viewer; the viewer applies the same calls live.

export const PRIMARY = "Primary";
export type FixedBinding = "Wheel" | "Secondary" | "Auxiliary";

/** A tool's permanent (non-left-button) binding, if any. */
export type FixedBindings = Record<string, FixedBinding | undefined>;

export interface ToolBindingState {
  /** Tool insertion order (matches `toolGroup.addTool` order). */
  readonly order: string[];
  /** Permanent wheel/right/middle binding per tool (never moves). */
  readonly fixed: FixedBindings;
  /** Current bindings per tool (the set Cornerstone would hold). */
  bindings: Record<string, Set<string>>;
  /** The tool that currently owns the left/Primary button, if any. */
  leftTool: string | null;
}

/** Build the initial binding state: every fixed binding applied, no left tool. */
export function initToolBindings(
  order: string[],
  fixed: FixedBindings
): ToolBindingState {
  const bindings: Record<string, Set<string>> = {};
  for (const name of order) {
    bindings[name] = new Set();
    const f = fixed[name];
    if (f) bindings[name].add(f);
  }
  return { order, fixed, bindings, leftTool: null };
}

/**
 * Move the Primary (left button) binding to `name`. Mirrors exactly what the
 * viewer does against the real Cornerstone tool group:
 *   • remove ONLY Primary from the outgoing tool (its fixed binding stays),
 *   • add Primary to the incoming tool.
 */
export function setLeftTool(state: ToolBindingState, name: string): ToolBindingState {
  if (!state.bindings[name]) {
    throw new Error(`unknown tool: ${name}`);
  }
  if (state.leftTool && state.leftTool !== name) {
    state.bindings[state.leftTool].delete(PRIMARY);
  }
  state.bindings[name].add(PRIMARY);
  state.leftTool = name;
  return state;
}

/**
 * Resolve which tool fires for a given pressed button — the FIRST tool in
 * insertion order whose bindings include that button. This is the exact
 * semantics of Cornerstone's `getActiveToolForMouseEvent`, and the assertion
 * that this returns the *selected* tool for `Primary` is what guards the bug.
 */
export function resolveToolForButton(
  state: ToolBindingState,
  button: string
): string | null {
  for (const name of state.order) {
    if (state.bindings[name]?.has(button)) return name;
  }
  return null;
}
