type DicomJson = Record<string, { Value?: Array<number | string> }>;

/**
 * Order a stack along the slice normal, cranial end first for a standard
 * axial acquisition. Raw QIDO order is not anatomical; on the 65-slice LIDC
 * chest CT it put the "mid-chest" index in the abdomen.
 */
export function sortAxialStack<T extends DicomJson>(instances: readonly T[]): T[] {
  const scored = instances.map((inst, index) => {
    const pos = inst["00200032"]?.Value;
    const iop = inst["00200037"]?.Value;
    if (!pos || !iop || pos.length < 3 || iop.length < 6) return { inst, key: index, ok: false };
    const nums = [...iop.slice(0, 6), ...pos.slice(0, 3)].map((value) => Number(value));
    if (nums.some((value) => !Number.isFinite(value))) return { inst, key: index, ok: false };
    const [rx, ry, rz, cx, cy, cz, px, py, pz] = nums;
    const nx = ry * cz - rz * cy;
    const ny = rz * cx - rx * cz;
    const nz = rx * cy - ry * cx;
    return { inst, key: px * nx + py * ny + pz * nz, ok: true };
  });
  if (scored.some((item) => !item.ok)) return [...instances];
  return scored.sort((a, b) => b.key - a.key).map((item) => item.inst);
}
