// Multi-monitor UI rule: controls that exist to put a series on ANOTHER
// monitor (web "Pop out to new window", the desktop monitor picker and
// "next monitor" commands) appear only when the reader has two or more.
//
// Web: the Window Management API's `screen.isExtended` (Chromium) is the only
// signal a page gets. Browsers without it (Firefox, Safari) report undefined,
// and we treat that as one screen: hiding the control is the safe default.

export interface ScreenLike {
  isExtended?: boolean;
}

export function hasMultipleScreens(screen: ScreenLike | null | undefined): boolean {
  return screen?.isExtended === true;
}
