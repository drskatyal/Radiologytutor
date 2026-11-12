// Window presets per modality: the numbered list lives in the viewer core
// (`numberedWindowPresets`) so the web viewer's number keys match these.
// Other modalities get no fixed windows (a "Lung" window on an MR is noise).

import { numberedWindowPresets, type WindowPreset } from "@flowrad/viewer-core";

/** The modality's presets in number-key order (shared with the web viewer). */
export function windowPresetsFor(modality: string): WindowPreset[] {
  return numberedWindowPresets(modality);
}

export function voiRangeOf(ww: number, wc: number): { lower: number; upper: number } {
  return { lower: wc - ww / 2, upper: wc + ww / 2 };
}

export function wwwcOf(range: { lower: number; upper: number }): { ww: number; wc: number } {
  return { ww: range.upper - range.lower, wc: (range.upper + range.lower) / 2 };
}
