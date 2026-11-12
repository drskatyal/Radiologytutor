import { geometryFromDicom, uncalibratedGeometry, type ImageGeometry } from "./geometry";
// Geometry-only allowlist; never retain patient-module fields in this cache.
const cache = new Map<string, ImageGeometry>();
export function retainImageGeometry(imageId: string, dataset: unknown): void {
  const frame = Number(imageId.match(/\/frames\/(\d+)/)?.[1]);
  cache.set(imageId, geometryFromDicom(dataset, frame));
  if (cache.size > 20000) cache.delete(cache.keys().next().value!);
}
export function imageGeometry(imageId: string): ImageGeometry {
  return structuredClone(cache.get(imageId) ?? uncalibratedGeometry());
}
