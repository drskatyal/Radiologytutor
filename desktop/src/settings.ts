// Viewer settings: shape and defaults. Kept out of the dialogs so the start
// screen can read them without loading any dialog code.

import type { WindowArrangement } from "@flowrad/viewer-core";

export interface ViewerSettings {
  showOverlay: boolean;
  rememberHistory: boolean;
  checkUpdates: boolean;
  scaleBar: boolean;
  /** Local study database: also store patient name and ID (on this computer only) so they can be searched. */
  indexPatients: boolean;
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
  /** MPR and 3D rendered by the native (Rust) core: the volume never enters the webview. */
  nativeMpr: boolean;
  /** Re-mapped keyboard shortcuts: binding id → key spec ("Mod+Shift+K"). */
  shortcuts: Record<string, string>;
  /** Viewer windows on other monitors at last exit, reopened on the next study. */
  windowArrangements?: WindowArrangement[];
}

export const DEFAULT_SETTINGS: ViewerSettings = {
  showOverlay: true,
  rememberHistory: true,
  checkUpdates: true,
  scaleBar: false,
  indexPatients: true,
  hidePatient: false,
  compactSeries: false,
  nativeMpr: true,
  scrollSlicesPerNotch: 1,
  scrollDragPx: 0,
  scrollAcceleration: false,
  shortcuts: {},
};
