// PET/CT fusion: the pure parts, shared by FlowRad Viewer (desktop) and the
// free web viewer.
//
//   • which CT and PET series of a study to fuse;
//   • the dose / timing / weight tags that SUVbw needs, read from a DICOM
//     header (dicom-parser's DataSet or anything with the same accessors);
//   • shaping those tags for @cornerstonejs/calculate-suv;
//   • the overlay look: an opacity ramp that keeps background PET
//     transparent so the CT reads untinted.
//
// When a tag SUV needs is missing we never invent a factor: callers show raw
// values and say so.

/** A series as the pair picker needs it. */
export interface FusionCandidate {
  modality?: string | null;
  imageCount: number;
  frameOfReferenceUID?: string | null;
}

/** Smallest stack we treat as a volume (fewer slices are scouts or keys). */
export const FUSION_MIN_SLICES = 10;

/**
 * The CT and PET to fuse, as indexes into `series`: the active one when it
 * is a CT or PET volume, else the largest of each. When the active series
 * names a frame of reference, a partner on the same frame wins over a larger
 * one on another. Null when the study lacks either.
 */
export function pickFusionPair(series: readonly FusionCandidate[], active = -1): { ct: number; pt: number } | null {
  const isVolume = (i: number, modality: string) =>
    series[i]?.modality === modality && series[i]!.imageCount >= FUSION_MIN_SLICES;
  const largest = (modality: string, frame?: string | null) => {
    let best = -1;
    series.forEach((s, i) => {
      if (!isVolume(i, modality)) return;
      if (frame && s.frameOfReferenceUID && s.frameOfReferenceUID !== frame) return;
      if (best < 0 || s.imageCount > series[best]!.imageCount) best = i;
    });
    return best;
  };
  const activeFrame = series[active]?.frameOfReferenceUID ?? null;
  const pick = (modality: string) => {
    if (isVolume(active, modality)) return active;
    const sameFrame = activeFrame ? largest(modality, activeFrame) : -1;
    return sameFrame >= 0 ? sameFrame : largest(modality);
  };
  const ct = pick("CT");
  const pt = pick("PT");
  return ct >= 0 && pt >= 0 ? { ct, pt } : null;
}

/** dicom-parser's DataSet accessors (the subset used here). */
export interface PetTagReader {
  string(tag: string): string | undefined;
  floatString(tag: string): number | undefined;
  elements: Record<string, { items?: { dataSet?: PetTagReader }[] } | undefined>;
}

/** The tags @cornerstonejs/calculate-suv reads, straight from a PET header (absent ones left out). */
export function petMetaFromDataSet(ds: PetTagReader): Record<string, unknown> {
  const info = ds.elements.x00540016?.items?.[0]?.dataSet;
  const str = (r: PetTagReader | undefined, tag: string) => {
    const v = r?.string(tag)?.trim();
    return v ? v : undefined;
  };
  const num = (r: PetTagReader | undefined, tag: string) => {
    try {
      const v = r?.floatString(tag);
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const corrected = str(ds, "x00280051");
  return sanitizePetMeta({
    CorrectedImage: corrected ? corrected.split("\\").map((s) => s.trim()) : undefined,
    Units: str(ds, "x00541001"),
    DecayCorrection: str(ds, "x00541102"),
    PatientWeight: num(ds, "x00101030"),
    PatientSize: num(ds, "x00101020"),
    PatientSex: str(ds, "x00100040"),
    SeriesDate: str(ds, "x00080021"),
    SeriesTime: str(ds, "x00080031"),
    AcquisitionDate: str(ds, "x00080022"),
    AcquisitionTime: str(ds, "x00080032"),
    FrameReferenceTime: num(ds, "x00541300"),
    ActualFrameDuration: num(ds, "x00181242"),
    RadionuclideTotalDose: num(info, "x00181074"),
    RadionuclideHalfLife: num(info, "x00181075"),
    RadiopharmaceuticalStartTime: str(info, "x00181072"),
    RadiopharmaceuticalStartDateTime: str(info, "x00181078"),
  });
}

/** Whether SUVbw can be computed from these tags at all. */
export function hasSuvInputs(meta: Record<string, unknown>): boolean {
  return (
    meta.RadionuclideTotalDose != null &&
    meta.RadionuclideHalfLife != null &&
    meta.PatientWeight != null &&
    meta.Units != null &&
    (meta.RadiopharmaceuticalStartTime != null || meta.RadiopharmaceuticalStartDateTime != null)
  );
}

/**
 * Shape header tags for calculate-suv: drop absent (null) fields, and drop
 * sex + height unless the sex is M or F. Those two only feed SUL/BSA, and the
 * library throws on "O" (other), which would otherwise cost the reader SUVbw.
 */
export function sanitizePetMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (v != null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  if (out.PatientSex !== "M" && out.PatientSex !== "F") {
    delete out.PatientSex;
    delete out.PatientSize;
  }
  return out;
}

/** What the image loader records about its own pre-scaling of one image. */
export interface LoaderPreScale {
  enabled?: boolean;
  scaled?: boolean;
  scalingParameters?: { suvbw?: number };
}

/**
 * The SUV factor still to apply to a PET volume's values, or null when the
 * loader already applied it. Cornerstone skips pre-scaling (SUV included)
 * for a PET with slope 1 and intercept 0, and a volume without float
 * textures stays in raw counts: in both cases the factor is applied here.
 */
export function suvFactorToApply(
  imagePreScale: LoaderPreScale | undefined,
  volumePreScaled: boolean | undefined,
  suvbw: number | undefined
): number | null {
  if (!suvbw || !Number.isFinite(suvbw) || suvbw <= 0) return null;
  const applied = volumePreScaled !== false && !!imagePreScale?.scaled && typeof imagePreScale.scalingParameters?.suvbw === "number";
  return applied ? null : suvbw;
}

/**
 * Colour maps offered for the PET overlay: vtk.js preset names the volume
 * viewport resolves ("Hot Iron" is a CPU-only Cornerstone map and is not one;
 * lib/petFusion.test.ts checks every name).
 */
export const PET_COLORMAPS = ["hsv", "Inferno (matplotlib)", "jet", "Black-Body Radiation"] as const;

/** Labels for PET_COLORMAPS. */
export const PET_COLORMAP_LABELS: Record<(typeof PET_COLORMAPS)[number], string> = {
  hsv: "Rainbow (HSV)",
  "Inferno (matplotlib)": "Inferno (hot)",
  jet: "Jet",
  "Black-Body Radiation": "Black body",
};

/**
 * The PET overlay's opacity transfer function. In SUV, background (below
 * 0.5) is transparent and uptake ramps to `opacity` by 1.5 SUV. vtk.js
 * samples this into a fixed table across its own range, so the far point is
 * 100 SUV (not 1e6, which would put every real value in the first bin).
 * Raw (non-SUV) data gets a flat opacity. `rawPerSuv` converts the points
 * when the volume holds raw counts and SUV is applied beside it (1/suvbw).
 */
export function petOpacityRamp(opacity: number, suv: boolean, rawPerSuv = 1): number | { value: number; opacity: number }[] {
  if (!suv) return opacity;
  return [
    { value: 0, opacity: 0 },
    { value: 0.5 * rawPerSuv, opacity: 0 },
    { value: 1.5 * rawPerSuv, opacity },
    { value: 100 * rawPerSuv, opacity },
  ];
}
