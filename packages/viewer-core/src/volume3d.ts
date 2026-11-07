// 3D helpers: a cut plane through the volume and an iso-threshold "surface"
// look. Pure geometry / transfer-function maths; each app applies them to its
// renderer (vtk.js clipping planes and volume properties in Cornerstone).

export type CutAxis = "axial" | "coronal" | "sagittal";

/** Volume bounds in patient mm: [xmin, xmax, ymin, ymax, zmin, zmax] (LPS). */
export type Bounds = readonly [number, number, number, number, number, number];

export interface CutPlane {
  origin: [number, number, number];
  /** Points to the half that stays visible. */
  normal: [number, number, number];
}

const AXIS_INDEX: Record<CutAxis, 0 | 1 | 2> = { sagittal: 0, coronal: 1, axial: 2 };

/**
 * A plane perpendicular to `axis`, `fraction` (0–1) of the way through the
 * volume, keeping the far side (or the near side when `flip`). 0 shows all
 * of the volume, 1 hides it entirely.
 */
export function cutPlaneFor(bounds: Bounds, axis: CutAxis, fraction: number, flip = false): CutPlane {
  const i = AXIS_INDEX[axis];
  const lo = bounds[i * 2];
  const hi = bounds[i * 2 + 1];
  const f = Math.min(1, Math.max(0, fraction));
  const origin: [number, number, number] = [
    (bounds[0] + bounds[1]) / 2,
    (bounds[2] + bounds[3]) / 2,
    (bounds[4] + bounds[5]) / 2,
  ];
  const normal: [number, number, number] = [0, 0, 0];
  if (!flip) {
    origin[i] = lo + f * (hi - lo);
    normal[i] = 1;
  } else {
    origin[i] = hi - f * (hi - lo);
    normal[i] = -1;
  }
  return { origin, normal };
}

/** Is `point` on the kept side of `plane`? */
export function keeps(plane: CutPlane, point: readonly number[]): boolean {
  return (
    (point[0] - plane.origin[0]) * plane.normal[0] +
      (point[1] - plane.origin[1]) * plane.normal[1] +
      (point[2] - plane.origin[2]) * plane.normal[2] >=
    0
  );
}

export interface SurfaceTransfer {
  /** [value, opacity] pairs: a sharp step at the threshold. */
  opacity: [number, number][];
  /** [value, r, g, b] (0–1): bone-white above the threshold. */
  color: [number, number, number, number][];
}

/**
 * Shaded-surface look: fully transparent below `threshold`, opaque from just
 * above it, so the volume renders the iso-surface at that value (bone ≈ 250
 * HU, contrast vessels ≈ 150, skin ≈ −300). `range` is the data range.
 */
export function surfaceTransfer(threshold: number, range: readonly [number, number], softnessHu = 20): SurfaceTransfer {
  const [min, max] = range;
  const t = Math.min(max, Math.max(min, threshold));
  return {
    opacity: [
      [min, 0],
      [t - softnessHu / 2, 0],
      [t + softnessHu / 2, 1],
      [max, 1],
    ],
    color: [
      [min, 0.9, 0.82, 0.7],
      [t, 0.93, 0.88, 0.78],
      [max, 1, 0.98, 0.94],
    ],
  };
}

export const SURFACE_PRESETS: { id: string; label: string; threshold: number }[] = [
  { id: "bone", label: "Bone", threshold: 250 },
  { id: "vessels", label: "Contrast vessels", threshold: 150 },
  { id: "skin", label: "Skin", threshold: -300 },
];

// ───────────── applying them to a Cornerstone 3D viewport (any app) ─────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Viewport3D = { getActors?: () => { actor: any }[]; setProperties: (p: { preset?: string }) => void; render: () => void };

/** The volume's data range from its mapper input, or a CT default. */
function dataRange(actor: any): [number, number] {
  const r = actor?.getMapper?.()?.getInputData?.()?.getPointData?.()?.getScalars?.()?.getRange?.() as [number, number] | undefined;
  return r && r[0] !== r[1] ? r : [-1024, 3071];
}

/**
 * Volume rendering with `preset`, or — when `surfaceThreshold` is a number —
 * a shaded iso-surface at that value.
 */
export function applyVolumeLook(viewport: Viewport3D, preset: string, surfaceThreshold: number | null): void {
  viewport.setProperties({ preset });
  if (surfaceThreshold != null) {
    const actor = viewport.getActors?.()[0]?.actor;
    const property = actor?.getProperty?.();
    const t = surfaceTransfer(surfaceThreshold, dataRange(actor));
    const opacity = property?.getScalarOpacity?.(0);
    const color = property?.getRGBTransferFunction?.(0);
    if (opacity && color) {
      opacity.removeAllPoints();
      for (const [x, y] of t.opacity) opacity.addPoint(x, y);
      color.removeAllPoints();
      for (const [x, r, g, b] of t.color) color.addRGBPoint(x, r, g, b);
      property.setShade?.(true);
      property.setAmbient?.(0.25);
      property.setDiffuse?.(0.85);
      property.setSpecular?.(0.25);
      property.setSpecularPower?.(20);
    }
  }
  viewport.render();
}

/**
 * Clip the 3D view with one plane (or none). `makePlane` builds the renderer's
 * plane object (vtk.js: `vtkPlane.newInstance`), so this module stays free of
 * renderer imports.
 */
export function applyCutPlane(
  viewport: Viewport3D,
  cut: { axis: CutAxis; fraction: number; flip?: boolean } | null,
  makePlane: (p: CutPlane) => unknown
): void {
  const mapper = viewport.getActors?.()[0]?.actor?.getMapper?.();
  if (!mapper?.removeAllClippingPlanes) return;
  mapper.removeAllClippingPlanes();
  if (cut) {
    const bounds = mapper.getInputData?.()?.getBounds?.() as Bounds | undefined;
    if (bounds) mapper.addClippingPlane(makePlane(cutPlaneFor(bounds, cut.axis, cut.fraction, cut.flip)));
  }
  viewport.render();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
