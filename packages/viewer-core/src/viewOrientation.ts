// Rotate / flip: one command set for every surface (web toolbar, desktop
// toolbar, right-click menu, keyboard, native renderer).
//
// Orientation is display-only and per viewport: 90° steps clockwise plus a
// horizontal / vertical mirror. Flips are SCREEN flips — "flip horizontal"
// always mirrors left↔right as the reader sees it, whatever the rotation —
// and the edge letters (L/R/A/P/H/F) follow the image.
//
// The native renderer composes image → screen as  R(rotation) · F(flips)
// (flip in image space, then rotate clockwise; see native_view.rs). A screen
// mirror M after that is  M · R(θ) · F = R(−θ) · M · F, so a screen flip
// negates the rotation and toggles the image flip on the same axis. Pure, so
// both identities are unit tests rather than screenshot reviews.

export type OrientationCommand = "rotate:90" | "rotate:-90" | "rotate:180" | "flip:h" | "flip:v" | "orient:reset";

export interface OrientationEntry {
  command: OrientationCommand;
  label: string;
  /** Default key, for menus, tooltips and the ? sheet (same on web and desktop). */
  shortcut: string | null;
}

/** In menu order. The toolbar dropdown and the right-click submenu read this list. */
export const ORIENTATION_COMMANDS: readonly OrientationEntry[] = [
  { command: "rotate:90", label: "Rotate 90° clockwise", shortcut: "R" },
  { command: "rotate:-90", label: "Rotate 90° anticlockwise", shortcut: "Shift+R" },
  { command: "rotate:180", label: "Rotate 180°", shortcut: null },
  { command: "flip:h", label: "Flip horizontal", shortcut: "H" },
  { command: "flip:v", label: "Flip vertical", shortcut: "V" },
  { command: "orient:reset", label: "Reset orientation", shortcut: null },
];

export function isOrientationCommand(command: string): command is OrientationCommand {
  return ORIENTATION_COMMANDS.some((e) => e.command === command);
}

export interface ViewOrientation {
  /** Clockwise, 0 / 90 / 180 / 270. */
  rotation: number;
  /** Image-space mirrors (renderer convention: applied before the rotation). */
  flipH: boolean;
  flipV: boolean;
}

export const IDENTITY_ORIENTATION: ViewOrientation = { rotation: 0, flipH: false, flipV: false };

/** 0 / 90 / 180 / 270 for any multiple of 90 (negative included). */
export function normalizeRotation(deg: number): number {
  const q = Math.round(deg / 90);
  return (((q % 4) + 4) % 4) * 90;
}

/** The orientation after one command, flips taken in screen space. */
export function applyOrientation(o: ViewOrientation, command: OrientationCommand): ViewOrientation {
  switch (command) {
    case "rotate:90":
      return { ...o, rotation: normalizeRotation(o.rotation + 90) };
    case "rotate:-90":
      return { ...o, rotation: normalizeRotation(o.rotation - 90) };
    case "rotate:180":
      return { ...o, rotation: normalizeRotation(o.rotation + 180) };
    case "flip:h":
      return { rotation: normalizeRotation(-o.rotation), flipH: !o.flipH, flipV: o.flipV };
    case "flip:v":
      return { rotation: normalizeRotation(-o.rotation), flipH: o.flipH, flipV: !o.flipV };
    case "orient:reset":
      return { ...IDENTITY_ORIENTATION };
  }
}

/** Screen position of image point (x, y) relative to the image centre, y down. */
export function orientPoint(o: ViewOrientation, x: number, y: number): [number, number] {
  const fx = o.flipH ? -x : x;
  const fy = o.flipV ? -y : y;
  // `+ 0` folds −0 into 0.
  switch (normalizeRotation(o.rotation)) {
    case 90:
      return [-fy + 0, fx + 0];
    case 180:
      return [-fx + 0, -fy + 0];
    case 270:
      return [fy + 0, -fx + 0];
    default:
      return [fx + 0, fy + 0];
  }
}

export interface EdgeMarkers {
  top: string;
  bottom: string;
  left: string;
  right: string;
}

/**
 * Edge letters on screen for an image whose unrotated letters are `base`
 * (from ImageOrientationPatient, dicomOverlay.orientationMarkers).
 */
export function orientMarkers(base: EdgeMarkers, o: ViewOrientation): EdgeMarkers {
  const out: EdgeMarkers = { top: "", bottom: "", left: "", right: "" };
  const edges: [keyof EdgeMarkers, number, number][] = [
    ["right", 1, 0],
    ["left", -1, 0],
    ["bottom", 0, 1],
    ["top", 0, -1],
  ];
  for (const [edge, x, y] of edges) {
    const [sx, sy] = orientPoint(o, x, y);
    const screen: keyof EdgeMarkers = sx > 0.5 ? "right" : sx < -0.5 ? "left" : sy > 0.5 ? "bottom" : "top";
    out[screen] = base[edge];
  }
  return out;
}
