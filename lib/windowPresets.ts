// ============================================================================
// lib/windowPresets.ts
//
// Modality-aware Window/Level presets for the PACS viewer toolbar. A preset is
// just a window width (ww) + window center (wc) we feed to the viewer's
// `setWindow`. Kept here (not in the component) so it's pure, typed, and
// unit-testable, and so the same list can drive both the demo toolbar and any
// future modality-driven defaulting.
//
// CT values are the conventional radiology presets; the generic "Full dynamic"
// resets the viewport to the series' own VOI (handled by the caller).
// ============================================================================

export interface WindowPreset {
  id: string;
  label: string;
  /** Window width. */
  ww: number;
  /** Window center / level. */
  wc: number;
  /** Modalities this preset is meaningful for ("*" = any). */
  modalities: string[];
}

/** The canonical CT presets. */
export const WINDOW_PRESETS: WindowPreset[] = [
  { id: "ct-brain", label: "Brain", ww: 80, wc: 40, modalities: ["CT"] },
  { id: "ct-subdural", label: "Subdural", ww: 200, wc: 70, modalities: ["CT"] },
  { id: "ct-stroke", label: "Stroke", ww: 40, wc: 40, modalities: ["CT"] },
  { id: "ct-bone", label: "Bone", ww: 2500, wc: 480, modalities: ["CT"] },
  { id: "ct-lung", label: "Lung", ww: 1500, wc: -600, modalities: ["CT"] },
  { id: "ct-soft", label: "Soft tissue", ww: 400, wc: 40, modalities: ["CT"] },
  { id: "ct-liver", label: "Liver", ww: 150, wc: 60, modalities: ["CT"] },
  { id: "ct-angio", label: "Angio", ww: 600, wc: 300, modalities: ["CT"] },
];

/** The reset-to-series-default pseudo-preset id (no fixed ww/wc). */
export const FULL_DYNAMIC_ID = "full-dynamic";

/**
 * Presets relevant to a modality. Unknown/empty modality still gets the CT set
 * (the only clinically meaningful presets we ship) so the menu is never empty.
 */
export function presetsForModality(modality?: string): WindowPreset[] {
  const m = (modality || "").trim().toUpperCase();
  if (!m) return WINDOW_PRESETS;
  const matching = WINDOW_PRESETS.filter(
    (p) => p.modalities.includes("*") || p.modalities.includes(m)
  );
  return matching.length > 0 ? matching : WINDOW_PRESETS;
}

/** Match a (ww, wc) pair to a preset id, within a small tolerance. */
export function matchPreset(ww: number, wc: number): string | null {
  for (const p of WINDOW_PRESETS) {
    if (Math.abs(p.ww - ww) <= 1 && Math.abs(p.wc - wc) <= 1) return p.id;
  }
  return null;
}
