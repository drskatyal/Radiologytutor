// Viewer settings: shape and defaults. Kept out of the dialogs so the start
// screen can read them without loading any dialog code.

export interface ViewerSettings {
  showOverlay: boolean;
  rememberHistory: boolean;
  checkUpdates: boolean;
  scaleBar: boolean;
}

export const DEFAULT_SETTINGS: ViewerSettings = {
  showOverlay: true,
  rememberHistory: true,
  checkUpdates: true,
  scaleBar: false,
};
