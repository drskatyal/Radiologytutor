// The free viewer's scrolling settings (Settings › Scrolling), kept in this
// browser and applied to the live viewer: viewer-core scrollSensitivity's
// StackScroll reads them on every wheel and drag. The desktop keeps the same
// three in its own Settings.

import {
  parseScrollPreferences,
  serializeScrollPreferences,
  setScrollPreferences,
  SCROLL_PREFERENCES_STORAGE_KEY,
  type ScrollPreferences,
} from "@flowrad/viewer-core/scrollSensitivity";

/** This browser's remembered scrolling, applied (call once a page, before any wheel). */
export function loadScrollPreferences(): ScrollPreferences {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SCROLL_PREFERENCES_STORAGE_KEY);
  } catch {
    /* storage blocked: defaults */
  }
  const prefs = parseScrollPreferences(raw);
  setScrollPreferences(prefs);
  return prefs;
}

/** Apply now and remember in this browser. */
export function saveScrollPreferences(prefs: ScrollPreferences): void {
  setScrollPreferences(prefs);
  try {
    window.localStorage.setItem(SCROLL_PREFERENCES_STORAGE_KEY, serializeScrollPreferences(prefs));
  } catch {
    /* storage blocked: applies for this visit */
  }
}
