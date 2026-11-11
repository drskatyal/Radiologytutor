import { dicomWebRoot, imagingAuthHeader, orthancConfigured } from "./orthanc";
import { hashContent } from "./findingContent";
import type { FindingAnchorSnapshot, SeriesInventory } from "./types";
const first = (row: Record<string, { Value?: unknown[] }>, tag: string) => row[tag]?.Value?.[0];
export async function readFindingInventory(anchor: FindingAnchorSnapshot): Promise<SeriesInventory> {
  if (!orthancConfigured()) throw new Error("Image inventory unavailable");
  const response = await fetch(`${dicomWebRoot()}/studies/${encodeURIComponent(anchor.studyUID)}/series/${encodeURIComponent(anchor.seriesUID)}/metadata`, {
    headers: { Authorization: await imagingAuthHeader(), Accept: "application/dicom+json" }, cache: "no-store", signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Image inventory unavailable");
  return inventoryFromMetadata(anchor, await response.json());
}
export function inventoryFromMetadata(anchor: FindingAnchorSnapshot, raw: unknown): SeriesInventory {
  if (!Array.isArray(raw)) throw new Error("Invalid image inventory");
  const instances = raw.map((row: Record<string, { Value?: unknown[] }>) => {
    if (first(row, "0020000D") !== anchor.studyUID || first(row, "0020000E") !== anchor.seriesUID) throw new Error("Image inventory identity mismatch");
    const sopUID = String(first(row, "00080018") ?? "");
    const frames = Number(first(row, "00280008") ?? 1);
    if (!sopUID || !Number.isInteger(frames) || frames < 1) throw new Error("Invalid image identity");
    return { sopUID, frames, geometryHash: hashContent(Object.fromEntries(["00280010", "00280011", "00280030", "00181164", "00200032", "00200037", "52009229", "52009230"].map(tag => [tag, row[tag] ?? null]))) };
  });
  if (new Set(instances.map(i => i.sopUID)).size !== instances.length) throw new Error("Ambiguous SOP identity");
  return { studyUID: anchor.studyUID, seriesUID: anchor.seriesUID, orderingAlgorithmVersion: "archive-v1", instances };
}
export function instanceSetFingerprint(inventory: SeriesInventory): string {
  return hashContent({ studyUID: inventory.studyUID, seriesUID: inventory.seriesUID, instances: [...inventory.instances].sort((a, b) => a.sopUID.localeCompare(b.sopUID)) });
}
export function resolveFindingAnchor(anchor: FindingAnchorSnapshot | undefined, inventory?: SeriesInventory): "resolved" | "unresolved" | "legacy_index" {
  if (!anchor?.studyUID || !anchor.seriesUID || !anchor.sopUID || !Number.isInteger(anchor.frame) || anchor.frame < 1) return "legacy_index";
  if (!inventory || inventory.studyUID !== anchor.studyUID || inventory.seriesUID !== anchor.seriesUID) return "unresolved";
  const instance = inventory.instances.find(i => i.sopUID === anchor.sopUID);
  return instance && anchor.frame <= instance.frames ? "resolved" : "unresolved";
}
