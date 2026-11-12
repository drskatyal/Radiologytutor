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
  for (const p of [...WINDOW_PRESETS, ...CT_EXTRA_PRESETS, ...PT_PRESETS]) {
    if (p.ww < 50 ? Math.abs(p.ww - ww) <= 0.01 && Math.abs(p.wc - wc) <= 0.01 : Math.abs(p.ww - ww) <= 1 && Math.abs(p.wc - wc) <= 1) return p.id;
  }
  return null;
}

// ── Numbered presets: number keys 1–9, the same on web and desktop ──────────

/** CT reads a desktop viewer is expected to offer beyond the canonical set. */
export const CT_EXTRA_PRESETS: WindowPreset[] = [
  { id: "ct-mediastinum", label: "Mediastinum", ww: 350, wc: 50, modalities: ["CT"] },
  { id: "ct-abdomen", label: "Abdomen", ww: 400, wc: 60, modalities: ["CT"] },
  { id: "ct-spine", label: "Spine", ww: 1800, wc: 400, modalities: ["CT"] },
  { id: "ct-temporal", label: "Temporal bone", ww: 4000, wc: 700, modalities: ["CT"] },
];

/** Number keys 1–9 follow this order: the four everyday reads first. */
export const CT_PRESET_ORDER = [
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
] as const;

/** PET in SUV (the loader scales PT to SUVbw when the dose tags are present). */
export const PT_PRESETS: WindowPreset[] = [
  { id: "pt-suv5", label: "SUV 0–5", ww: 5, wc: 2.5, modalities: ["PT"] },
  { id: "pt-suv10", label: "SUV 0–10", ww: 10, wc: 5, modalities: ["PT"] },
  { id: "pt-suv15", label: "SUV 0–15", ww: 15, wc: 7.5, modalities: ["PT"] },
];

/**
 * The modality's own presets in number-key order (key n = entry n-1): the
 * desktop viewer's list. Empty for modalities with no fixed windows (MR,
 * X-ray), where a CT "Lung" is noise.
 */
export function numberedWindowPresets(modality?: string): WindowPreset[] {
  const m = (modality || "").trim().toUpperCase();
  if (m === "CT") {
    const all = [...WINDOW_PRESETS, ...CT_EXTRA_PRESETS];
    return CT_PRESET_ORDER.map((id) => all.find((p) => p.id === id)).filter((p): p is WindowPreset => !!p);
  }
  if (m === "PT") return PT_PRESETS;
  return [];
}

/**
 * The web viewer's preset menu, in number-key order: the numbered list where
 * the modality has one, else the CT set it has always offered (so the menu is
 * never empty; keys follow the menu, which shows each one's key).
 */
export function viewerWindowPresets(modality?: string): WindowPreset[] {
  const numbered = numberedWindowPresets(modality);
  return numbered.length > 0 ? numbered : presetsForModality(modality);
}

/**
 * A typed window (Set window dialog, web and desktop): width and level as the
 * reader entered them, or null when they don't make a window. Width must be at
 * least 1 (DICOM C.11.2.1.2); either value may be negative (CT lung level).
 * Commas are read as decimal points ("1,5" from a European keyboard).
 */
export function parseCustomWindow(ww: string, wc: string): { ww: number; wc: number } | null {
  const num = (s: string) => {
    const t = s.trim().replace(",", ".");
    if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return Number.NaN;
    return Number(t);
  };
  const w = num(ww);
  const c = num(wc);
  if (!Number.isFinite(w) || w < 1 || !Number.isFinite(c)) return null;
  return { ww: w, wc: c };
}
