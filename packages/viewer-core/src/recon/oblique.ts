// Multi-oblique MPR: three mutually perpendicular planes through one point.
//
// Each pane has a frame (u = screen right, v = screen down, normal = u × v);
// the three normals stay orthonormal. The shared crosshair `center` lies on
// all three planes, so clicking in one pane moves the other two (linked
// crosshairs). Rotating the crosshair line in pane i turns the OTHER two
// planes about pane i's normal; pane i itself does not spin. Repeating that
// in a second pane gives a double-oblique plane.
//
// A pane's image is centred on the volume centre projected onto its plane
// (plus the reader's pan), not on the crosshair, so the anatomy does not jump
// when the crosshair moves.

import {
  add,
  cross,
  dot,
  normalize,
  rotate,
  scale,
  sub,
  volumeCenter,
  type Vec3,
  type VolumeGeometry,
} from "./geometry";
import type { PlaneGrid, Projection } from "./sampler";

export interface PaneFrame {
  /** Unit screen-right direction (patient). */
  u: Vec3;
  /** Unit screen-down direction (patient). */
  v: Vec3;
}

export interface ObliqueState {
  center: Vec3;
  panes: [PaneFrame, PaneFrame, PaneFrame];
}

export const paneNormal = (f: PaneFrame): Vec3 => normalize(cross(f.u, f.v));

/** Radiological axial / coronal / sagittal (patient axes, LPS). */
export function cardinalFrames(): [PaneFrame, PaneFrame, PaneFrame] {
  return [
    { u: [1, 0, 0], v: [0, 1, 0] }, // axial: right → patient left, down → posterior
    { u: [1, 0, 0], v: [0, 0, -1] }, // coronal: down → feet
    { u: [0, 1, 0], v: [0, 0, -1] }, // sagittal: right → posterior, down → feet
  ];
}

/**
 * Frames aligned to the acquisition (the native slice plane and its two
 * perpendiculars), for an oblique scan read in its own orientation.
 */
export function acquisitionFrames(g: VolumeGeometry): [PaneFrame, PaneFrame, PaneFrame] {
  const row = normalize(g.axes[0]);
  const col = normalize(sub(g.axes[1], scale(row, dot(g.axes[1], row))));
  let n = normalize(cross(row, col));
  // "Down" of the two reformats points feet-ward, like a cardinal coronal.
  if (n[2] > 0) n = scale(n, -1);
  return [
    { u: row, v: col },
    { u: row, v: n },
    { u: col, v: n },
  ].map(orthonormal) as [PaneFrame, PaneFrame, PaneFrame];
}

export function initialOblique(g: VolumeGeometry, align: "patient" | "acquisition" = "patient"): ObliqueState {
  return { center: volumeCenter(g), panes: align === "patient" ? cardinalFrames() : acquisitionFrames(g) };
}

function orthonormal(f: PaneFrame): PaneFrame {
  const u = normalize(f.u);
  const v = normalize(sub(f.v, scale(u, dot(f.v, u))));
  return { u, v };
}

/** Turn the other two planes about pane `i`'s normal by `rad` (screen-angle sense). */
export function rotateOthers(s: ObliqueState, i: number, rad: number): ObliqueState {
  const k = paneNormal(s.panes[i]);
  const panes = s.panes.map((f, j) => (j === i ? f : orthonormal({ u: rotate(f.u, k, rad), v: rotate(f.v, k, rad) }))) as ObliqueState["panes"];
  return { ...s, panes };
}

/** Scroll pane `i`: move the crosshair `mm` along its normal. */
export function scrollPane(s: ObliqueState, i: number, mm: number): ObliqueState {
  return { ...s, center: add(s.center, scale(paneNormal(s.panes[i]), mm)) };
}

export interface PaneView {
  /** Field of view across the pane's shorter side (mm). */
  fovMm: number;
  /** Pan of the image centre, in mm along u and v. */
  pan: [number, number];
}

export interface PaneGrid extends PlaneGrid {
  pixelMm: number;
  frame: PaneFrame;
  normal: Vec3;
}

/** The sampling grid for pane `i` drawn at `width` × `height` pixels. */
export function paneGrid(
  g: VolumeGeometry,
  s: ObliqueState,
  i: number,
  view: PaneView,
  width: number,
  height: number,
  slab?: { mode: Projection; thicknessMm: number }
): PaneGrid {
  const frame = s.panes[i];
  const n = paneNormal(frame);
  const vc = volumeCenter(g);
  // Volume centre projected onto this pane's plane (through the crosshair).
  const onPlane = sub(vc, scale(n, dot(sub(vc, s.center), n)));
  const imageCenter = add(onPlane, add(scale(frame.u, view.pan[0]), scale(frame.v, view.pan[1])));
  const pixelMm = view.fovMm / Math.max(1, Math.min(width, height));
  const du = scale(frame.u, pixelMm);
  const dv = scale(frame.v, pixelMm);
  const origin = sub(sub(imageCenter, scale(du, (width - 1) / 2)), scale(dv, (height - 1) / 2));
  return {
    kind: "plane",
    origin,
    du,
    dv,
    width,
    height,
    slab: slab && slab.thicknessMm > 0 ? { ...slab, normal: n } : undefined,
    pixelMm,
    frame,
    normal: n,
  };
}

/** Pane pixel of a patient point, with its distance (mm) from the plane. */
export function patientToPane(grid: PaneGrid, p: Vec3): { x: number; y: number; depthMm: number } {
  const d = sub(p, grid.origin);
  return { x: dot(d, grid.frame.u) / grid.pixelMm, y: dot(d, grid.frame.v) / grid.pixelMm, depthMm: dot(d, grid.normal) };
}

/** Patient point under pane pixel (x, y), on the plane. */
export function paneToPatient(grid: PaneGrid, x: number, y: number): Vec3 {
  return add(grid.origin, add(scale(grid.du, x), scale(grid.dv, y)));
}

/**
 * The other planes' traces in pane `i`: lines through the crosshair, as a
 * unit screen direction (x right, y down) per other pane index.
 */
export function crosshairLines(s: ObliqueState, i: number): { pane: number; dir: [number, number] }[] {
  const f = s.panes[i];
  const n = paneNormal(f);
  return [0, 1, 2]
    .filter((j) => j !== i)
    .map((j) => {
      const d = cross(n, paneNormal(s.panes[j]));
      const x = dot(d, f.u);
      const y = dot(d, f.v);
      const len = Math.hypot(x, y) || 1;
      return { pane: j, dir: [x / len, y / len] as [number, number] };
    });
}

/** Largest deviation from orthonormality (tests; drift guard). */
export function orthogonalityError(s: ObliqueState): number {
  const n = s.panes.map(paneNormal);
  return Math.max(Math.abs(dot(n[0], n[1])), Math.abs(dot(n[0], n[2])), Math.abs(dot(n[1], n[2])), ...s.panes.map((f) => Math.abs(dot(f.u, f.v))));
}
