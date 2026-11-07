// Edge orientation letters (R/L, A/P, H/F) from the camera. Pure, so the
// "is the spine at the bottom of an axial" question is a unit test, not a
// screenshot review.

export type Vec3 = [number, number, number];

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Patient-axis letters for a direction in DICOM LPS space, strongest first.
 * +x = Left, +y = Posterior, +z = Head. Up to two letters (an oblique reads
 * "LP"), skipping components under 0.3 so near-axial stays one letter.
 */
export function directionLabel(v: Vec3): string {
  const parts: { letter: string; weight: number }[] = [
    { letter: v[0] >= 0 ? "L" : "R", weight: Math.abs(v[0]) },
    { letter: v[1] >= 0 ? "P" : "A", weight: Math.abs(v[1]) },
    { letter: v[2] >= 0 ? "H" : "F", weight: Math.abs(v[2]) },
  ];
  return parts
    .filter((p) => p.weight >= 0.3)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2)
    .map((p) => p.letter)
    .join("");
}

export interface EdgeLabels {
  top: string;
  bottom: string;
  left: string;
  right: string;
}

/** Screen-right is viewUp × viewPlaneNormal in Cornerstone's camera model. */
export function edgeLabels(viewUp: Vec3, viewPlaneNormal: Vec3): EdgeLabels {
  const right = cross(viewUp, viewPlaneNormal);
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
  return {
    top: directionLabel(viewUp),
    bottom: directionLabel(neg(viewUp)),
    right: directionLabel(right),
    left: directionLabel(neg(right)),
  };
}
