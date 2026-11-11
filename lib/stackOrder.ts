// The order of an archive (WADO-RS) stack.
//
// An archive returns a series' instances in its own order — Orthanc by its
// internal ids — which is not anatomy. The de-identified LIDC chest CT on
// staging came back as Loc 344, 154, 119, 334, 199, … so the stack jumped
// between chest and kidneys on every scroll, and an authored slice index
// landed wherever that order put it.
//
// Ordering, as PACS vendors and the local viewer (viewer-core localStudy) do:
//   1. Along the slice normal: ImagePositionPatient · (row × column cosines),
//      when EVERY instance has a position and they are not all equal.
//   2. InstanceNumber, when positions are missing or degenerate.
//   3. The archive's own order, as the last resort (stable).
//
// Direction: the stack runs the way InstanceNumber runs when the instances
// carry one (LIDC: InstanceNumber 1 is the most cranial slice, z −79, down to
// z −399), so indices authored against the acquisition order land where they
// were authored. Without InstanceNumbers, the slice most along the normal
// comes first (axial: the most cranial, as a radiologist scrolls a CT).
//
// Pure: DICOM JSON (PS3.18 F.2) in, the same objects out.

const ORIENTATION = "00200037";
const POSITION = "00200032";
const INSTANCE_NUMBER = "00200013";

export interface StackGeometry {
  /** Signed distance along the slice normal (mm), or null. */
  position: number | null;
  instanceNumber: number | null;
}

function values(dataset: unknown, tag: string): unknown[] | null {
  const element = (dataset as Record<string, { Value?: unknown[] } | undefined> | null)?.[tag];
  return Array.isArray(element?.Value) ? element!.Value! : null;
}

function finite(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Position along the slice normal and InstanceNumber of one DICOM JSON dataset. */
export function stackGeometry(dataset: unknown): StackGeometry {
  const o = (values(dataset, ORIENTATION) ?? []).map(finite);
  const p = (values(dataset, POSITION) ?? []).map(finite);
  const instanceNumber = finite(values(dataset, INSTANCE_NUMBER)?.[0]);
  if (o.length < 6 || p.length < 3 || o.some((v) => v == null) || p.some((v) => v == null)) {
    return { position: null, instanceNumber };
  }
  const [r0, r1, r2, c0, c1, c2] = o as number[];
  const n0 = r1 * c2 - r2 * c1;
  const n1 = r2 * c0 - r0 * c2;
  const n2 = r0 * c1 - r1 * c0;
  const length = Math.hypot(n0, n1, n2);
  if (!Number.isFinite(length) || length < 1e-6) return { position: null, instanceNumber };
  const [p0, p1, p2] = p as number[];
  return { position: (n0 * p0 + n1 * p1 + n2 * p2) / length + 0, instanceNumber };
}

/**
 * The stack order of a series as indexes into `geometry`: position along the
 * normal (direction following InstanceNumber), else InstanceNumber, else the
 * given order. Stable.
 */
export function stackOrder(geometry: readonly StackGeometry[]): number[] {
  const positions = geometry.map((g) => g.position);
  const byPosition =
    positions.every((v) => v != null) && new Set(positions as number[]).size > 1;
  const numbered = geometry.filter((g) => g.instanceNumber != null);
  // +1: ascending position; −1: descending.
  let direction = -1;
  if (byPosition && numbered.length >= 2) {
    const first = numbered.reduce((a, b) => (b.instanceNumber! < a.instanceNumber! ? b : a));
    const last = numbered.reduce((a, b) => (b.instanceNumber! > a.instanceNumber! ? b : a));
    if (first.position! !== last.position!) direction = first.position! < last.position! ? 1 : -1;
  }
  return geometry
    .map((g, index) => ({ g, index }))
    .sort((a, b) => {
      if (byPosition && a.g.position !== b.g.position) return direction * (a.g.position! - b.g.position!);
      const an = a.g.instanceNumber;
      const bn = b.g.instanceNumber;
      if (an != null && bn != null && an !== bn) return an - bn;
      if (an != null && bn == null) return -1;
      if (an == null && bn != null) return 1;
      return a.index - b.index;
    })
    .map(({ index }) => index);
}

/** A series' DICOM JSON datasets in stack order (a new array; the objects are the same). */
export function orderStackDatasets<T>(datasets: readonly T[]): T[] {
  return stackOrder(datasets.map(stackGeometry)).map((index) => datasets[index]!);
}
