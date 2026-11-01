// Viewer settings: shape and defaults. Kept out of the dialogs so the start
// screen can read them without loading any dialog code.

export interface ViewerSettings {
  showOverlay: boolean;
  rememberHistory: boolean;
  checkUpdates: boolean;
  scaleBar: boolean;
  /** Teaching / screen-sharing: hide patient name, ID and birth date everywhere on screen. */
  hidePatient: boolean;
  /** Series browser as a dense text list instead of thumbnails. */
  compactSeries: boolean;
  /** Slices per mouse-wheel notch (1–10). */
  scrollSlicesPerNotch: number;
  /** Pixels of browse-drag (B tool) per slice; 0 = automatic. */
  scrollDragPx: number;
  /** Quick runs of wheel notches move progressively further. */
  scrollAcceleration: boolean;
}

export const DEFAULT_SETTINGS: ViewerSettings = {
  showOverlay: true,
  rememberHistory: true,
  checkUpdates: true,
  scaleBar: false,
  hidePatient: false,
  compactSeries: false,
  scrollSlicesPerNotch: 1,
  scrollDragPx: 0,
  scrollAcceleration: false,
};
