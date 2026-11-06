// MPR layout: three boxes, one tall box on the left and two stacked on the
// right. Each box picks its plane (Axial / Coronal / Sagittal) from a
// dropdown. Picking a plane another box already shows swaps the two, so all
// three planes stay on screen and no box is ever empty or duplicated.
//
// The choice is remembered per machine (localStorage), a convenience only:
// a missing or malformed value falls back to the default.

export type Plane = "axial" | "coronal" | "sagittal";

export const MPR_PLANE_LABELS: Record<Plane, string> = {
  axial: "Axial",
  coronal: "Coronal",
  sagittal: "Sagittal",
};
export const MPR_PLANES: readonly Plane[] = ["axial", "coronal", "sagittal"];

/** Box 0 is the tall box; boxes 1 and 2 are stacked top and bottom. */
export type MprSlots = readonly [Plane, Plane, Plane];
export const DEFAULT_MPR_SLOTS: MprSlots = ["axial", "coronal", "sagittal"];
export const MPR_SLOTS_KEY = "flowrad.mpr.slots";

/** Put `plane` in box `index`; the box that showed it takes the old plane. */
export function assignMprSlot(
  slots: MprSlots,
  index: number,
  plane: Plane,
): MprSlots {
  if (index < 0 || index > 2 || slots[index] === plane) return slots;
  const next = [...slots] as [Plane, Plane, Plane];
  const from = next.indexOf(plane);
  if (from >= 0) next[from] = next[index];
  next[index] = plane;
  return next;
}

/** A stored layout, if it is exactly one of each plane; otherwise null. */
export function parseMprSlots(raw: unknown): MprSlots | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (
    !v.every(
      (p): p is Plane =>
        typeof p === "string" && (MPR_PLANES as readonly string[]).includes(p),
    )
  )
    return null;
  return new Set(v).size === 3 ? (v as unknown as MprSlots) : null;
}

/** Grid placement of each box: tall box left (2/3 width), two stacked right. */
export const MPR_SLOT_CLASSES = [
  "col-start-1 row-start-1 row-span-2",
  "col-start-2 row-start-1",
  "col-start-2 row-start-2",
] as const;

export function loadMprSlots(): MprSlots {
  try {
    return (
      parseMprSlots(window.localStorage.getItem(MPR_SLOTS_KEY)) ??
      DEFAULT_MPR_SLOTS
    );
  } catch {
    return DEFAULT_MPR_SLOTS;
  }
}

export function saveMprSlots(slots: MprSlots): void {
  try {
    window.localStorage.setItem(MPR_SLOTS_KEY, JSON.stringify(slots));
  } catch {
    /* storage blocked: the layout just isn't remembered */
  }
}
