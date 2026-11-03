// Slab changes from outside a reformat / MPR (keys, voice, the right-click
// menu), applied the same way by every view. Pure, so the "second change
// does not register" class of bug (HP 0.8.1: 10 mm then 20 mm) is a test.

import { SLAB_THICKNESS_MM, type MenuEntry } from "@flowrad/viewer-core";

export type SlabMode = "off" | "mip" | "minip" | "avg";
export interface Slab {
  mode: SlabMode;
  /** Thickness in mm (0 = a single slice). */
  mm: number;
}

export const SLAB_MAX_MM = 100;

/** One change: a mode, a step (Ctrl+] / Ctrl+wheel) and / or an absolute thickness. */
export interface SlabChange {
  mode?: SlabMode;
  deltaMm?: number;
  mm?: number;
}

export function applySlabChange(s: Slab, c: SlabChange): Slab {
  let next = s;
  if (c.mode) next = { mode: c.mode, mm: c.mode === "off" ? 0 : next.mm || 10 };
  if (c.deltaMm) {
    const mm = Math.max(0, Math.min(SLAB_MAX_MM, next.mm + c.deltaMm));
    // Thickening from a single slice starts a MIP (RadiAnt's default).
    next = { mode: mm === 0 ? "off" : next.mode === "off" ? "mip" : next.mode, mm };
  }
  if (c.mm) {
    const mm = Math.max(1, Math.min(SLAB_MAX_MM, c.mm));
    next = { mode: next.mode === "off" ? "mip" : next.mode, mm };
  }
  return next;
}

/** A menu command ("slab:mip", "slab-mm:20") as a change; null for any other command. */
export function slabChangeOf(command: string): SlabChange | null {
  const [head, arg] = command.split(":");
  if (head === "slab" && (arg === "off" || arg === "mip" || arg === "minip" || arg === "avg")) return { mode: arg };
  if (head === "slab-mm" && Number(arg) > 0) return { mm: Number(arg) };
  return null;
}

const NAMES: Record<SlabMode, string> = { off: "Thin", mip: "MIP", minip: "MinIP", avg: "AvgIP" };

/** The right-click menu of an MPR pane: slab, reset, back to 2D. */
export function mprPaneMenu(slab: Slab): MenuEntry[] {
  return [
    {
      kind: "sub",
      id: "slab",
      label: "Slab",
      hint: slab.mode === "off" ? undefined : `${NAMES[slab.mode]} ${slab.mm} mm`,
      items: () => [
        { kind: "item", id: "slab:off", label: "Thin (single slice)", checked: slab.mode === "off" },
        { kind: "item", id: "slab:mip", label: "MIP", checked: slab.mode === "mip" },
        { kind: "item", id: "slab:minip", label: "MinIP", checked: slab.mode === "minip" },
        { kind: "item", id: "slab:avg", label: "Average (AvgIP)", checked: slab.mode === "avg" },
        { kind: "label", label: "Thickness" },
        ...SLAB_THICKNESS_MM.map((mm): MenuEntry => ({ kind: "item", id: `slab-mm:${mm}`, label: `${mm} mm`, checked: slab.mode !== "off" && slab.mm === mm })),
      ],
    },
    { kind: "sep" },
    { kind: "item", id: "reset", label: "Reset view" },
    { kind: "item", id: "exit", label: "Back to 2D" },
  ];
}
