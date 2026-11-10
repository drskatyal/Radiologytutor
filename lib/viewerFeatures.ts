// What a viewer surface offers beyond the shared core, as named groups.
//
// One web viewer serves two products: the FlowRad free viewer (/viewer,
// /viewer/local) — the desktop's full reading set — and RadLearn's teaching
// screens, which keep a cut-down tool set because recordings and the tutor are
// built around it. This replaces the single `readingTools` boolean, which
// switched all of the free viewer's extras on or off together, so a later
// surface can take, say, layouts without export.
//
// Defaults are unchanged: every group is OFF unless a surface asks for it
// (RadLearn), and the free viewer asks for all of them (FREE_VIEWER_FEATURES).
//
// Pure: no React, no Cornerstone.

export interface ViewerFeatures {
  /**
   * The extended measure set (Cobb angle, bidirectional, circle and freehand
   * ROIs, magnifier, text box, eraser), the measurements panel, and the
   * desktop's tool letters (D, Y, N, C, P).
   */
  tools: boolean;
  /** Custom grid layouts, Shift+1…7, linked panes, distraction-free reading, PET/CT fusion. */
  layouts: boolean;
  /** The Export dialog (images, video, anonymised DICOM), Ctrl/⌘+E, save-annotated. */
  export: boolean;
  /** Thick slabs (MIP/MinIP/AvgIP, T, Ctrl/⌘+[ ]), reformat, oblique/curved MPR and 3D from the menu. */
  slabs: boolean;
  /** Local-file reading settings: scroll feel and the on-device privacy panel. */
  localStudies: boolean;
  /** The reading-room keymap (RadiAnt-style keys, digit presets, Esc cancels a drawing) and its menu hints. */
  keys: boolean;
}

export type ViewerFeatureName = keyof ViewerFeatures;

export const VIEWER_FEATURE_NAMES: readonly ViewerFeatureName[] = [
  "tools",
  "layouts",
  "export",
  "slabs",
  "localStudies",
  "keys",
];

/** RadLearn's teaching surfaces, and the default for any surface that does not ask. */
export const TEACHING_FEATURES: Readonly<ViewerFeatures> = Object.freeze({
  tools: false,
  layouts: false,
  export: false,
  slabs: false,
  localStudies: false,
  keys: false,
});

/** The FlowRad free viewer: everything the desktop app has. */
export const FREE_VIEWER_FEATURES: Readonly<ViewerFeatures> = Object.freeze({
  tools: true,
  layouts: true,
  export: true,
  slabs: true,
  localStudies: true,
  keys: true,
});

/** Fill a partial request: anything not named is off. */
export function viewerFeatures(input?: Partial<ViewerFeatures> | null): ViewerFeatures {
  const out = { ...TEACHING_FEATURES };
  if (!input) return out;
  for (const name of VIEWER_FEATURE_NAMES) if (input[name] === true) out[name] = true;
  return out;
}

/** True when the surface offers any of the free viewer's extras. */
export function anyViewerFeature(features: ViewerFeatures): boolean {
  return VIEWER_FEATURE_NAMES.some((name) => features[name]);
}
