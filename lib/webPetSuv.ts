// ============================================================================
// lib/webPetSuv.ts
//
// PET → SUVbw on the free web viewer, as on FlowRad Viewer (desktop
// viewer/suv.ts). Cornerstone pre-scales PT pixels to SUV when a
// `scalingModule` metadata provider returns `suvbw` for the imageId, in
// stack and volume views alike. The factors come from
// @cornerstonejs/calculate-suv over the dose, timing and weight tags, read
// here from each instance's own header (the `File` the loader holds:
// nothing leaves the browser).
//
// Missing or inconsistent tags: no factor is invented. The series stays in
// raw units and the caller says so.
// ============================================================================

import { hasSuvInputs, petMetaFromDataSet, type PetTagReader } from "@flowrad/viewer-core/petFusion";

export type SuvState = "suv" | "raw";

const factors = new Map<string, { suvbw: number }>();
const bySeries = new Map<string, Promise<SuvState>>();
let providerAdded = false;

/** Header bytes read per file: PET headers are small, pixel data is never needed. */
const HEADER_BYTES = 512 * 1024;

const baseOf = (imageId: string) => imageId.replace(/[?&]frame=\d+$/, "");

/** Whether this PET stack shows SUVbw ("suv") or raw units ("raw"). Computed once per stack. */
export function ensureWebSuv(imageIds: readonly string[]): Promise<SuvState> {
  if (!imageIds.length) return Promise.resolve("raw");
  const key = `${imageIds.length}:${imageIds[0]}:${imageIds[imageIds.length - 1]}`;
  let pending = bySeries.get(key);
  if (!pending) {
    pending = computeSuv(imageIds).catch(() => "raw" as const);
    bySeries.set(key, pending);
  }
  return pending;
}

async function readHeader(file: File, parse: (b: Uint8Array, o: { untilTag: string }) => unknown): Promise<PetTagReader> {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, HEADER_BYTES)).arrayBuffer());
  try {
    return parse(head, { untilTag: "x7fe00010" }) as PetTagReader;
  } catch {
    // A header longer than the slice: read the whole file once.
    return parse(new Uint8Array(await file.arrayBuffer()), { untilTag: "x7fe00010" }) as PetTagReader;
  }
}

async function computeSuv(imageIds: readonly string[]): Promise<SuvState> {
  const [loader, parser, suv, core] = await Promise.all([
    import("@cornerstonejs/dicom-image-loader"),
    import("dicom-parser"),
    import("@cornerstonejs/calculate-suv"),
    import("@cornerstonejs/core"),
  ]);
  const fileManager = ((loader as { default?: unknown }).default ?? loader) as {
    wadouri: { fileManager: { get(index: number): File | undefined } };
  };
  const parse = ((parser as { default?: unknown }).default ?? parser) as { parseDicom: (b: Uint8Array, o: { untilTag: string }) => unknown };
  const bases = [...new Set(imageIds.map(baseOf))];
  const metas: Record<string, unknown>[] = [];
  for (const base of bases) {
    const match = /^dicomfile:(\d+)$/.exec(base);
    const file = match ? fileManager.wadouri.fileManager.get(Number(match[1])) : undefined;
    if (!file) return "raw";
    const meta = petMetaFromDataSet(await readHeader(file, parse.parseDicom));
    if (!hasSuvInputs(meta)) return "raw";
    metas.push(meta);
  }
  const results = suv.calculateSUVScalingFactors(metas as never);
  const byBase = new Map(bases.map((b, i) => [b, results[i]?.suvbw]));
  const next = new Map<string, { suvbw: number }>();
  for (const id of imageIds) {
    const suvbw = byBase.get(baseOf(id));
    if (!suvbw || !Number.isFinite(suvbw) || suvbw <= 0) return "raw";
    next.set(id, { suvbw });
  }
  for (const [id, f] of next) factors.set(id, f);
  if (!providerAdded) {
    core.metaData.addProvider((type: string, imageId: string) => (type === "scalingModule" ? factors.get(imageId) : undefined), 10000);
    providerAdded = true;
  }
  // Images decoded before the factors existed hold raw values: drop them so
  // the next load (volume or stack) scales to SUV.
  for (const id of imageIds) {
    try {
      core.cache.removeImageLoadObject(id, { force: true }); // throws when not cached
    } catch {
      /* in use or already gone */
    }
  }
  return "suv";
}
