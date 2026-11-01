// Window presets per modality. CT values are the shared web presets
// (`lib/windowPresets.ts`) plus the reads a desktop viewer is expected to
// offer; other modalities get presets that mean something for them instead of
// falling back to CT windows (a "Lung" window on an MR is noise).

import { WINDOW_PRESETS, type WindowPreset } from "@flowrad/viewer-core";

const CT_EXTRA: WindowPreset[] = [
  { id: "ct-mediastinum", label: "Mediastinum", ww: 350, wc: 50, modalities: ["CT"] },
  { id: "ct-abdomen", label: "Abdomen", ww: 400, wc: 60, modalities: ["CT"] },
  { id: "ct-spine", label: "Spine", ww: 1800, wc: 400, modalities: ["CT"] },
  { id: "ct-temporal", label: "Temporal bone", ww: 4000, wc: 700, modalities: ["CT"] },
];

/** Number keys 1–9 follow this order: the four everyday reads first. */
const CT_ORDER = [
  "ct-lung",
  "ct-bone",
  "ct-brain",
  "ct-abdomen",
  "ct-mediastinum",
  "ct-soft",
  "ct-liver",
  "ct-subdural",
  "ct-stroke",
  "ct-angio",
  "ct-spine",
  "ct-temporal",
];

/** PET in SUV (the loader scales PT to SUVbw when the dose tags are present). */
const PT: WindowPreset[] = [
  { id: "pt-suv5", label: "SUV 0–5", ww: 5, wc: 2.5, modalities: ["PT"] },
  { id: "pt-suv10", label: "SUV 0–10", ww: 10, wc: 5, modalities: ["PT"] },
  { id: "pt-suv15", label: "SUV 0–15", ww: 15, wc: 7.5, modalities: ["PT"] },
];

export function windowPresetsFor(modality: string): WindowPreset[] {
  const m = modality.toUpperCase();
  if (m === "CT") {
    const all = [...WINDOW_PRESETS, ...CT_EXTRA];
    return CT_ORDER.map((id) => all.find((p) => p.id === id)).filter((p): p is WindowPreset => !!p);
  }
  if (m === "PT") return PT;
  return [];
}

export function voiRangeOf(ww: number, wc: number): { lower: number; upper: number } {
  return { lower: wc - ww / 2, upper: wc + ww / 2 };
}

export function wwwcOf(range: { lower: number; upper: number }): { ww: number; wc: number } {
  return { ww: range.upper - range.lower, wc: (range.upper + range.lower) / 2 };
}
