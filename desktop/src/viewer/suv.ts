// PET → SUV (body weight).
//
// Cornerstone pre-scales PT pixels to SUV when a `scalingModule` metadata
// provider returns `suvbw` for the imageId, in both stack and volume views.
// The factors come from `@cornerstonejs/calculate-suv` over the dose, timing
// and weight tags that the Rust side reads only for PET (`pet_metadata`).
//
// When the tags are missing or inconsistent we do not invent a factor: the
// viewer shows raw values and says so (`suvState`).

import { calculateSUVScalingFactors } from "@cornerstonejs/calculate-suv";
import { invoke, isTauri } from "../platform";
import type { ViewerSeries } from "../types";
import { getEngine } from "./engine";

type SuvState = "suv" | "raw";
const bySeries = new Map<string, Promise<SuvState>>();
const factors = new Map<string, { suvbw: number }>();
let providerAdded = false;

/** Whether this PT series is displayed in SUVbw ("suv") or raw units ("raw"). */
export function ensureSuv(series: ViewerSeries): Promise<SuvState> {
  if (series.modality !== "PT" || !isTauri) return Promise.resolve("raw");
  let pending = bySeries.get(series.uid);
  if (!pending) {
    pending = computeSuv(series).catch(() => "raw" as const);
    bySeries.set(series.uid, pending);
  }
  return pending;
}

async function computeSuv(series: ViewerSeries): Promise<SuvState> {
  // One entry per instance (frames of a multiframe share their header).
  const instances = [...new Map(series.headers.map((h) => [h.fileId, h])).values()];
  const metas = await invoke<(Record<string, unknown> | null)[]>("pet_metadata", {
    fileIds: instances.map((h) => h.fileId),
  });
  if (metas.some((m) => !m || m.RadionuclideTotalDose == null || m.PatientWeight == null)) return "raw";
  const results = calculateSUVScalingFactors(
    metas.map((m) => sanitizePetMeta(m!)) as unknown as Parameters<typeof calculateSUVScalingFactors>[0]
  );
  const byFile = new Map(instances.map((h, i) => [h.fileId, results[i]?.suvbw]));
  for (let i = 0; i < series.imageIds.length; i += 1) {
    const suvbw = byFile.get(series.headers[i].fileId);
    if (!suvbw || !Number.isFinite(suvbw)) return "raw";
    factors.set(series.imageIds[i], { suvbw });
  }
  if (!providerAdded) {
    const { core } = await getEngine();
    core.metaData.addProvider(
      (type: string, imageId: string) => (type === "scalingModule" ? factors.get(imageId) : undefined),
      10000
    );
    providerAdded = true;
  }
  return "suv";
}

/**
 * Shape the Rust tags for calculate-suv: drop absent (null) fields, and drop
 * sex + height unless the sex is M or F. Those two only feed SUL/BSA, and the
 * library throws on "O" (other) — which would otherwise cost the reader SUVbw.
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
