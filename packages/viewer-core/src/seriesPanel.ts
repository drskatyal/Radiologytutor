// The series panel beside the viewports: open or collapsed to a slim rail.
// Remembered per device (browser / WebView storage), the same key on the web
// viewer and the desktop app. Storage can be missing or throw (private
// windows, blocked site data): the panel then simply opens.

export const SERIES_PANEL_STORAGE_KEY = "flowrad.seriesPanel.collapsed";

/** Default shortcut on both surfaces (Cmd on macOS). */
export const SERIES_PANEL_SHORTCUT = "Mod+B";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readSeriesPanelCollapsed(store: KeyValueStore | null = storage()): boolean {
  try {
    return store?.getItem(SERIES_PANEL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSeriesPanelCollapsed(collapsed: boolean, store: KeyValueStore | null = storage()): void {
  try {
    store?.setItem(SERIES_PANEL_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    /* not remembered; still toggles */
  }
}

/** Ctrl+B (Cmd+B on a Mac), no Shift / Alt. */
export function isSeriesPanelShortcut(
  e: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean },
  mac = false
): boolean {
  const mod = mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
  return mod && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === "b" || e.code === "KeyB");
}
