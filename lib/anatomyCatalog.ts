/**
 * Generic schematic torso used when a patient mesh is not available.
 * Positions match `public/anatomy/generic-schematic.glb` (built by
 * `scripts/build-generic-anatomy.ts`). This is not a segmentation of a study.
 */

export interface AnatomyFindingMark {
  findingId?: string;
  label: string;
  position: [number, number, number];
  /**
   * The slice and marker this position was computed from. A store seeded
   * before the finding moved still has the old anchor; the 3D view must not
   * claim a lesion the 2D view is not showing.
   */
  sliceIndex?: number;
  marker?: { x_pct: number; y_pct: number };
}

/** True when a manifest mark was built from this finding's current anchor. */
export function markMatchesFinding(
  mark: AnatomyFindingMark,
  finding: { sliceIndex?: number; marker?: { x_pct: number; y_pct: number } | null } | undefined
): boolean {
  if (!finding) return false;
  if (mark.sliceIndex == null || !mark.marker) return true;
  if (finding.sliceIndex !== mark.sliceIndex || !finding.marker) return false;
  return (
    Math.abs(finding.marker.x_pct - mark.marker.x_pct) <= 0.01 &&
    Math.abs(finding.marker.y_pct - mark.marker.y_pct) <= 0.01
  );
}

export interface AnatomyManifest {
  source: "totalsegmentator" | "generic-schematic";
  caseId?: string;
  glb: string;
  disclaimer: string;
  structures: AnatomyStructure[];
  findings: AnatomyFindingMark[];
  /** Set by the panel from the teaching step. Not stored in the file. */
  activeFindingId?: string;
}

export interface AnatomyStructure {
  id: string;
  /** glTF node / mesh name. */
  node: string;
  label: string;
  position: [number, number, number];
  scale?: [number, number, number];
  /** sRGB hex, written into the glTF material. */
  color?: string;
  /** Camera seat when the tutor (or the learner) flies to this structure. */
  camera: [number, number, number];
}

export const ANATOMY_SOURCE = "generic-schematic" as const;

export const ANATOMY_DISCLAIMER =
  "Generic schematic anatomy. Not derived from this patient's CT.";

export const GENERIC_STRUCTURES: readonly AnatomyStructure[] = [
  {
    id: "trachea",
    node: "Trachea",
    label: "Trachea",
    position: [0.02, 1.42, 0.02],
    scale: [0.16, 0.42, 0.16],
    color: "#E4D2B0",
    camera: [0.9, 1.85, 2.15],
  },
  {
    id: "right-lung",
    node: "RightLung",
    label: "Right lung",
    position: [-0.74, 0.58, 0.02],
    scale: [0.62, 0.86, 0.5],
    color: "#7EBEB4",
    camera: [-1.85, 1.15, 2.35],
  },
  {
    id: "left-lung",
    node: "LeftLung",
    label: "Left lung",
    position: [0.76, 0.64, 0.04],
    scale: [0.54, 0.78, 0.46],
    color: "#6AAEA4",
    camera: [1.9, 1.2, 2.3],
  },
  {
    id: "heart",
    node: "Heart",
    label: "Heart",
    position: [0.22, 0.18, 0.32],
    scale: [0.4, 0.44, 0.36],
    color: "#D26574",
    camera: [0.55, 0.55, 2.15],
  },
  {
    id: "aorta",
    node: "Aorta",
    label: "Aorta",
    position: [0.12, 0.72, 0.18],
    scale: [0.12, 0.92, 0.12],
    color: "#E15B68",
    camera: [1.15, 1.05, 2.05],
  },
  {
    id: "liver",
    node: "Liver",
    label: "Liver",
    position: [-0.18, -0.78, 0.12],
    scale: [0.92, 0.4, 0.58],
    color: "#C4845C",
    camera: [-0.2, -0.15, 2.55],
  },
];

export function structureById(id: string | null | undefined): AnatomyStructure | undefined {
  if (!id) return undefined;
  return GENERIC_STRUCTURES.find((item) => item.id === id || item.node === id);
}
