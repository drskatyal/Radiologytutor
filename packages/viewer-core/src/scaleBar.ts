// The scale bar, as the desktop's "Scale bar" setting draws it: a calibrated
// ruler along the bottom of the image, a round length (1, 2 or 5 × 10ⁿ mm)
// that follows the zoom. Only on images whose header gives the pixel spacing:
// without it the bar would be a guess, and a wrong ruler is worse than none.
//
// Pure: millimetres per screen pixel and the pane's width in, bar out.

export const SCALE_BAR_STORAGE_KEY = "flowrad.viewer.scaleBar";

/** A ruler to draw: its length on screen (CSS px) and in the patient. */
export interface ScaleBar {
  px: number;
  mm: number;
  /** "5 mm", "2 cm", "10 cm". */
  label: string;
}

/** The ruler takes at most this share of the pane's width… */
export const SCALE_BAR_MAX_FRACTION = 0.3;
/** …and is never shorter than this (CSS px): below it there is no room for one. */
export const SCALE_BAR_MIN_PX = 24;

const NICE = [1, 2, 5];

/** "5 mm" under a centimetre, then whole centimetres ("2 cm", "10 cm"). */
export function scaleBarLabel(mm: number): string {
  if (mm >= 10 && mm % 10 === 0) return `${mm / 10} cm`;
  return `${mm} mm`;
}

/**
 * The longest round length that fits in SCALE_BAR_MAX_FRACTION of the pane,
 * or null when the inputs give none (no calibration, no pane, or a zoom so
 * far out that even 1 mm… or so far in that nothing round fits).
 */
export function scaleBarFor(mmPerPx: number | null | undefined, paneWidthPx: number): ScaleBar | null {
  if (!mmPerPx || !(mmPerPx > 0) || !Number.isFinite(mmPerPx) || !(paneWidthPx > 0)) return null;
  const maxMm = paneWidthPx * SCALE_BAR_MAX_FRACTION * mmPerPx;
  let best: number | null = null;
  for (let exp = 0; exp <= 4; exp += 1) {
    for (const n of NICE) {
      const mm = n * 10 ** exp;
      if (mm <= maxMm) best = mm;
    }
  }
  if (best == null) return null;
  const px = best / mmPerPx;
  if (px < SCALE_BAR_MIN_PX) return null;
  return { px: Math.round(px * 10) / 10, mm: best, label: scaleBarLabel(best) };
}

/** Millimetres per CSS pixel from the camera: the view is 2 × parallelScale mm tall. */
export function mmPerCssPixel(parallelScaleMm: number | null | undefined, paneCssHeight: number): number | null {
  if (!parallelScaleMm || !(parallelScaleMm > 0) || !(paneCssHeight > 0)) return null;
  return (2 * parallelScaleMm) / paneCssHeight;
}
