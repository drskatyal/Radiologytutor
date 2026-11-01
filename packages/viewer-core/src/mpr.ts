// Multiplanar reconstruction — geometry checks and camera math only.
// No Cornerstone import: the stack viewer must not pull a volume loader
// just to decide whether a series can be reconstructed.
//
// A series can enter MPR when it is CT or MR (or modality is unknown) and
// the slices already carry orientation, position, a shared grid, and regular
// spacing. Anything else stays on the stack with a short explanation.
// Slice jumps use that same metadata. A missing anchor does not get a
// guessed focal point.

export const MIN_MPR_SLICES = 8;

/** Parallel normals closer than this are one acquisition axis. */
const NORMAL_DOT_MIN = 0.999;
/** Spacing steps farther apart than this are not one volume. */
const SPACING_RATIO_MAX = 4;
const POSITION_EPS_MM = 0.05;

export type MprPlane = "axial" | "coronal" | "sagittal";
export type MprMode = "stack" | "mpr";
/** How the volume is shown once MPR is on. */
export type MprRender = "mpr" | "mip" | "3d";
/** MIP slab thickness, mm. Thick enough to follow a vessel or find a nodule. */
export const MIP_SLAB_MM = 15;

/** Which plane the keyboard scrolls: the last one the reader touched. */
export function planeForViewportId(
  viewportId: string | null | undefined,
  ids: { axial: string; coronal: string; sagittal: string }
): MprPlane {
  if (viewportId === ids.coronal) return "coronal";
  if (viewportId === ids.sagittal) return "sagittal";
  return "axial";
}

export type MprBlockReason = "modality" | "count" | "pixels" | "geometry" | "spacing";

export type MprAssessment =
  | { ok: true }
  | { ok: false; reason: MprBlockReason; message: string };

export interface PlaneSample {
  imagePositionPatient?: ArrayLike<number> | null;
  imageOrientationPatient?: ArrayLike<number> | null;
  rows?: number | null;
  columns?: number | null;
  rowPixelSpacing?: number | null;
  columnPixelSpacing?: number | null;
  pixelSpacing?: ArrayLike<number> | null;
  /** True when the loader substituted orientation, position, or spacing. */
  usingDefaultValues?: boolean;
}

export interface MprSessionHandle {
  volumeKey: string;
  destroy: () => void;
  replace: (
    imageIds: string[],
    imageId?: string,
    voi?: { ww: number; wc: number } | null
  ) => Promise<void>;
  /** Move every plane to this image's slice center. False when the anchor is missing. */
  jumpToImageId: (imageId: string) => boolean;
  setVoi: (ww: number, wc: number) => void;
  setInvert: (value: boolean) => void;
  resetView: () => void;
  resize: () => void;
  setLeftTool: (name: string) => void;
  restoreCrosshairs: () => void;
  /** Thin MPR, MIP slab, or a 3D volume render (needs `elements.volume3d`). */
  setRender: (mode: MprRender) => Promise<boolean>;
  /** Scroll one plane by `delta` slices (keyboard). */
  scrollPlane: (plane: MprPlane, delta: number) => void;
}

export type MprAction = "idle" | "teardown" | "mount" | "replace" | "fallback";

const MPR_MODALITIES = new Set(["CT", "MR", "MRI"]);

export function modalityAllowsMpr(modality: string | null | undefined): boolean {
  if (!modality || !modality.trim()) return true;
  return MPR_MODALITIES.has(modality.trim().toUpperCase());
}

/** DICOM modality wins, then the series rail, then the case label. */
export function modalityForMpr(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function mprViewportIds(instanceId: string): {
  axial: string;
  coronal: string;
  sagittal: string;
  toolGroupId: string;
  voiSyncId: string;
} {
  return {
    axial: `FLOWRAD_MPR_${instanceId}_axial`,
    coronal: `FLOWRAD_MPR_${instanceId}_coronal`,
    sagittal: `FLOWRAD_MPR_${instanceId}_sagittal`,
    toolGroupId: `flowrad-mpr-tg-${instanceId}`,
    voiSyncId: `flowrad-mpr-voi-${instanceId}`,
  };
}

export function mprVolumeKey(imageIds: readonly string[]): string {
  const head = imageIds[0] ?? "";
  const tail = imageIds[imageIds.length - 1] ?? "";
  let hash = 2166136261;
  const source = `${imageIds.length}\0${head}\0${tail}`;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Streaming volume scheme. Pixels load after the shell exists — callers should not await them. */
export function mprVolumeId(instanceId: string, imageIds: readonly string[]): string {
  return `cornerstoneStreamingImageVolume:flowrad-${instanceId}-${mprVolumeKey(imageIds)}`;
}

export function mprLoadFailureMessage(): string {
  return "This series couldn't be reconstructed. The stack view stays on.";
}

function block(reason: MprBlockReason, message: string): MprAssessment {
  return { ok: false, reason, message };
}

function finiteTuple(value: ArrayLike<number> | null | undefined, length: number): number[] | null {
  if (!value || value.length < length) return null;
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const n = Number(value[i]);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

function positiveSpacing(plane: PlaneSample): [number, number] | null {
  const raw = plane.pixelSpacing;
  const row = raw && raw.length >= 2 ? Number(raw[0]) : Number(plane.rowPixelSpacing);
  const col = raw && raw.length >= 2 ? Number(raw[1]) : Number(plane.columnPixelSpacing);
  if (!Number.isFinite(row) || !Number.isFinite(col) || row <= 0 || col <= 0) return null;
  if (!raw || raw.length < 2) return null;
  return [row, col];
}

export function planeNormal(iop: ArrayLike<number>): [number, number, number] | null {
  const o = finiteTuple(iop, 6);
  if (!o) return null;
  const n: [number, number, number] = [
    o[1] * o[5] - o[2] * o[4],
    o[2] * o[3] - o[0] * o[5],
    o[0] * o[4] - o[1] * o[3],
  ];
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-6) return null;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/**
 * Patient-space center of a slice. Null when orientation, position, grid, or
 * pixel spacing is missing or was filled in by the loader — we do not invent one.
 */
export function sliceCenterPatient(plane: PlaneSample | null | undefined): [number, number, number] | null {
  if (!plane || plane.usingDefaultValues) return null;
  const ipp = finiteTuple(plane.imagePositionPatient, 3);
  const iop = finiteTuple(plane.imageOrientationPatient, 6);
  const spacing = plane ? positiveSpacing(plane) : null;
  const rows = Number(plane.rows);
  const cols = Number(plane.columns);
  if (!ipp || !iop || !spacing || !Number.isFinite(rows) || !Number.isFinite(cols)) return null;
  if (rows < 2 || cols < 2) return null;
  const [rowSpacing, colSpacing] = spacing;
  // Same mapping as Cornerstone's imageToWorldCoords: index 0 along the row cosine.
  const c0 = cols / 2;
  const c1 = rows / 2;
  return [
    ipp[0] + iop[0] * rowSpacing * (c0 - 0.5) + iop[3] * colSpacing * (c1 - 0.5),
    ipp[1] + iop[1] * rowSpacing * (c0 - 0.5) + iop[4] * colSpacing * (c1 - 0.5),
    ipp[2] + iop[2] * rowSpacing * (c0 - 0.5) + iop[5] * colSpacing * (c1 - 0.5),
  ];
}

export function cameraLookingAt(
  camera: {
    focalPoint?: ArrayLike<number> | null;
    position?: ArrayLike<number> | null;
    viewPlaneNormal?: ArrayLike<number> | null;
  },
  focalPoint: [number, number, number]
): { focalPoint: [number, number, number]; position: [number, number, number] } | null {
  const fp = finiteTuple(camera.focalPoint, 3);
  const pos = finiteTuple(camera.position, 3);
  if (!fp || !pos) return null;
  let dx = pos[0] - fp[0];
  let dy = pos[1] - fp[1];
  let dz = pos[2] - fp[2];
  // A collapsed camera has no viewing distance. Keep the focal point and
  // step back along the plane normal so the viewport can still draw.
  if (Math.hypot(dx, dy, dz) < 1) {
    const normal = finiteTuple(camera.viewPlaneNormal, 3);
    if (!normal) return null;
    const len = Math.hypot(normal[0], normal[1], normal[2]);
    if (len < 1e-6) return null;
    dx = (normal[0] / len) * 500;
    dy = (normal[1] / len) * 500;
    dz = (normal[2] / len) * 500;
  }
  return {
    focalPoint,
    position: [focalPoint[0] + dx, focalPoint[1] + dy, focalPoint[2] + dz],
  };
}

export interface SliceAnchor {
  index: number;
  center: [number, number, number] | null;
  normal: [number, number, number] | null;
}

/** Nearest authored slice to a focal point. Slices without a center are ignored. */
export function nearestSliceIndex(
  focal: [number, number, number],
  slices: readonly SliceAnchor[]
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const slice of slices) {
    if (!slice.center || !slice.normal) continue;
    const dx = focal[0] - slice.center[0];
    const dy = focal[1] - slice.center[1];
    const dz = focal[2] - slice.center[2];
    const dist = Math.abs(dx * slice.normal[0] + dy * slice.normal[1] + dz * slice.normal[2]);
    if (dist < bestDist - 1e-4) {
      bestDist = dist;
      best = slice.index;
    }
  }
  return best;
}

function asPlane(value: unknown): PlaneSample | null {
  if (!value || typeof value !== "object") return null;
  return value as PlaneSample;
}

export function planesFromMetadata(
  get: (type: string, imageId: string) => unknown,
  imageIds: readonly string[]
): { planes: Array<PlaneSample | null>; dicomModality: string | null } {
  let dicomModality: string | null = null;
  const planes = imageIds.map((imageId, index) => {
    let plane: PlaneSample | null = null;
    let series: { modality?: string } | null = null;
    try {
      plane = asPlane(get("imagePlaneModule", imageId));
    } catch {
      plane = null;
    }
    if (index === 0) {
      try {
        series = get("generalSeriesModule", imageId) as { modality?: string } | null;
      } catch {
        series = null;
      }
      if (series && typeof series.modality === "string" && series.modality.trim()) {
        dicomModality = series.modality.trim();
      }
    }
    return plane;
  });
  return { planes, dicomModality };
}

export function assessMpr(
  planes: readonly (PlaneSample | null | undefined)[],
  options?: { modality?: string | null }
): MprAssessment {
  if (!modalityAllowsMpr(options?.modality)) {
    return block(
      "modality",
      "MPR is for CT and MR volumes. This series stays in the stack view."
    );
  }
  const count = planes.length;
  if (count < MIN_MPR_SLICES) {
    const noun = count === 1 ? "slice" : "slices";
    return block(
      "count",
      `This series has ${count} ${noun}, which is too few to reconstruct axial, coronal, and sagittal planes. The stack view stays on.`
    );
  }

  const rows = Number(planes[0]?.rows);
  const cols = Number(planes[0]?.columns);
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 2 || cols < 2) {
    return block(
      "geometry",
      "This series has no spatial orientation, so the planes can't be reconstructed. The stack view stays on."
    );
  }

  const normals: Array<[number, number, number]> = [];
  const positions: number[] = [];
  for (const plane of planes) {
    if (!plane) {
      return block(
        "geometry",
        "This series has no spatial orientation, so the planes can't be reconstructed. The stack view stays on."
      );
    }
    if (!positiveSpacing(plane)) {
      return block(
        "pixels",
        "This series has no pixel spacing, so a volume can't be built. The stack view stays on."
      );
    }
    if (plane.usingDefaultValues || sliceCenterPatient(plane) == null) {
      return block(
        "geometry",
        "This series has no spatial orientation, so the planes can't be reconstructed. The stack view stays on."
      );
    }
    if (Number(plane.rows) !== rows || Number(plane.columns) !== cols) {
      return block(
        "geometry",
        "The slices don't share one grid, so they can't be reconstructed. The stack view stays on."
      );
    }
    const normal = planeNormal(plane.imageOrientationPatient ?? []);
    const ipp = finiteTuple(plane.imagePositionPatient, 3);
    if (!normal || !ipp) {
      return block(
        "geometry",
        "This series has no spatial orientation, so the planes can't be reconstructed. The stack view stays on."
      );
    }
    if (normals.length) {
      const dot = Math.abs(normal[0] * normals[0][0] + normal[1] * normals[0][1] + normal[2] * normals[0][2]);
      if (dot < NORMAL_DOT_MIN) {
        return block(
          "geometry",
          "The slices aren't parallel, so they can't be reconstructed. The stack view stays on."
        );
      }
    }
    normals.push(normal);
    positions.push(ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2]);
  }

  const sorted = [...positions].sort((a, b) => a - b);
  const steps: number[] = [];
  for (let i = 1; i < sorted.length; i++) steps.push(sorted[i] - sorted[i - 1]);
  const minStep = Math.min(...steps);
  const maxStep = Math.max(...steps);
  if (minStep < POSITION_EPS_MM || maxStep / minStep > SPACING_RATIO_MAX) {
    return block(
      "spacing",
      "The slices in this series aren't a regular volume, so they can't be reconstructed. The stack view stays on."
    );
  }
  return { ok: true };
}

export function nextMprAction(input: {
  mode: MprMode;
  session: boolean;
  canReconstruct: boolean;
  volumeKey: string | null;
  loadedKey: string | null;
}): MprAction {
  if (input.mode === "stack") return input.session ? "teardown" : "idle";
  if (!input.canReconstruct) return "fallback";
  if (!input.session) return "mount";
  if (input.volumeKey && input.volumeKey !== input.loadedKey) return "replace";
  return "idle";
}

/** Crosshair colors on the black imaging surface. One hue per plane. */
export const MPR_REFERENCE_LINE: Record<MprPlane, string> = {
  axial: "rgb(47, 132, 255)",
  coronal: "rgb(72, 201, 176)",
  sagittal: "rgb(232, 180, 96)",
};
