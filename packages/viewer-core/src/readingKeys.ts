// RadiAnt's reading keys, as the desktop viewer has them, for any viewer
// built on this core: Ctrl/⌘+0 fit, Ctrl/⌘+1…4 zoom 100 / 200 / 400 / 800 %
// (one image pixel per screen pixel at 100 %), Ctrl/⌘+arrows pan, F12 show /
// hide annotations, Ctrl/⌘+F12 reference lines, and F5 / Shift+F5 / Alt+F5
// to link scroll, window / level and zoom across panes; Alt+A / C / S
// reformat the pane to axial / coronal / sagittal; Shift+E the eraser;
// Ctrl/⌘+Shift+Backspace (or Delete) clears the measurements; Space plays
// cine, Shift+[ / ] slows / speeds it, [ / ] change series, Ctrl/⌘+M MPR,
// Ctrl/⌘+Shift+M 3D, Ctrl/⌘+Shift+F12 overlay on / off, and F full screen
// (isFullScreenKey: the page that owns the stage handles it).
//
// Pure: key in, intent out. The host decides what it can do (a single pane
// has nothing to link) and must only call this for keys aimed at the image,
// since F5 and F12 are the browser's reload and developer-tools keys
// everywhere else.

export type ReadingKeyAction =
  | { type: "zoomTo"; scale: number | "fit" }
  | { type: "pan"; dx: number; dy: number }
  | { type: "annotations" }
  | { type: "referenceLines" }
  | { type: "link"; what: "scroll" | "voi" | "zoom" }
  | { type: "reformat"; plane: "axial" | "coronal" | "sagittal" }
  | { type: "eraser" }
  | { type: "clearMeasurements" }
  | { type: "cine" }
  | { type: "cineFps"; delta: 1 | -1 }
  | { type: "series"; delta: 1 | -1 }
  | { type: "mpr" }
  | { type: "volume3d" }
  | { type: "overlay" };

export interface ReadingKeyEvent {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Screen pixels a Ctrl/⌘+arrow press pans, as on the desktop. */
export const PAN_STEP_PX = 40;

/** Ctrl/⌘+0…4: fit, then 100 / 200 / 400 / 800 %. */
export const ZOOM_LEVELS: readonly (number | "fit")[] = ["fit", 1, 2, 4, 8];

/** The digit a key press means, from `code` when a layout shifts the key. */
function digitOf(e: ReadingKeyEvent): number | null {
  const fromCode = /^(?:Digit|Numpad)([0-9])$/.exec(e.code ?? "")?.[1];
  const d = fromCode ?? (/^[0-9]$/.test(e.key) ? e.key : undefined);
  return d == null ? null : Number(d);
}

export function resolveReadingKey(e: ReadingKeyEvent): ReadingKeyAction | null {
  const mod = !!(e.ctrlKey || e.metaKey);
  const shift = !!e.shiftKey;
  const alt = !!e.altKey;
  if (e.key === "F12") {
    if (!mod && !shift && !alt) return { type: "annotations" };
    if (mod && !shift && !alt) return { type: "referenceLines" };
    if (mod && shift && !alt) return { type: "overlay" };
    return null;
  }
  if (!mod && !alt) {
    if (!shift && (e.key === " " || e.code === "Space")) return { type: "cine" };
    // Shift+[ / ] type { / } on most layouts.
    if (e.key === "{" || (shift && e.key === "[")) return { type: "cineFps", delta: -1 };
    if (e.key === "}" || (shift && e.key === "]")) return { type: "cineFps", delta: 1 };
    if (!shift && e.key === "[") return { type: "series", delta: -1 };
    if (!shift && e.key === "]") return { type: "series", delta: 1 };
  }
  if (mod && !alt && (e.code === "KeyM" || e.key.toLowerCase() === "m")) return shift ? { type: "volume3d" } : { type: "mpr" };
  if (e.key === "F5" && !mod) {
    if (!shift && !alt) return { type: "link", what: "scroll" };
    if (shift && !alt) return { type: "link", what: "voi" };
    if (alt && !shift) return { type: "link", what: "zoom" };
    return null;
  }
  // Alt+A / C / S: by physical key, since on a Mac Alt types å / ç / ß.
  if (alt && !mod && !shift) {
    const letter = /^Key([ACS])$/.exec(e.code ?? "")?.[1] ?? (/^[acs]$/i.test(e.key) ? e.key.toUpperCase() : undefined);
    if (letter === "A") return { type: "reformat", plane: "axial" };
    if (letter === "C") return { type: "reformat", plane: "coronal" };
    if (letter === "S") return { type: "reformat", plane: "sagittal" };
    return null;
  }
  if (shift && !mod && !alt && (e.code === "KeyE" || e.key === "E")) return { type: "eraser" };
  if (mod && shift && !alt && (e.key === "Backspace" || e.key === "Delete")) return { type: "clearMeasurements" };
  if (!mod || shift || alt) return null;
  const d = digitOf(e);
  if (d != null && d < ZOOM_LEVELS.length) return { type: "zoomTo", scale: ZOOM_LEVELS[d]! };
  switch (e.key) {
    case "ArrowLeft":
      return { type: "pan", dx: -PAN_STEP_PX, dy: 0 };
    case "ArrowRight":
      return { type: "pan", dx: PAN_STEP_PX, dy: 0 };
    case "ArrowUp":
      return { type: "pan", dx: 0, dy: -PAN_STEP_PX };
    case "ArrowDown":
      return { type: "pan", dx: 0, dy: PAN_STEP_PX };
    default:
      return null;
  }
}

/**
 * The camera's parallel scale (half the visible height, in mm) that shows
 * the image at `scale` image pixels per screen pixel: at 1, one row of
 * pixels per CSS pixel of the pane. Null when the inputs can't give one.
 */
export function parallelScaleForPixelZoom(paneCssHeight: number, rowSpacingMm: number, scale: number): number | null {
  if (!(paneCssHeight > 0) || !(rowSpacingMm > 0) || !(scale > 0)) return null;
  return (paneCssHeight * rowSpacingMm) / (2 * scale);
}

/** "Zoom 200 %", "Fit to the pane": the confirmation a key press shows. */
export function zoomLevelLabel(scale: number | "fit"): string {
  return scale === "fit" ? "Fit to the pane" : `Zoom ${Math.round(scale * 100)} %`;
}

/** F (no modifiers): full screen, as on the desktop. For the page that owns the stage. */
export function isFullScreenKey(e: ReadingKeyEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "KeyF" || e.key === "f" || e.key === "F");
}
