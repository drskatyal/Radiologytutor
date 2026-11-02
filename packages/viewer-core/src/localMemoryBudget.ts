// An honest decoded-image cache cap for studies opened from local files.
//
// The device budget (viewerRuntime.ts `imageCacheBytes`) caps Cornerstone's
// decoded-image cache. For `dicomfile:` images that is only half the story:
// Cornerstone 5's wadouri loader keeps each cached image's whole Part 10 file
// (PixelData included) in its metadata store until the decoded image is
// evicted. A cached slice therefore costs decoded pixels PLUS its raw file —
// for an uncompressed CT, twice what the cap counts, so a "256 MB" phone
// budget really held ~512 MB.
//
// We know both sizes before the first pixel decodes: file sizes from the File
// handles, decoded sizes from Rows × Columns × SamplesPerPixel × BitsAllocated
// in the headers we already parsed. So the decoded cap is set to
//
//     deviceBudget / (1 + raw ÷ decoded)
//
// and decoded + raw together stay inside the device budget. A share of the
// budget (IN_FLIGHT_HEADROOM) is held back for slices whose file has been read
// but whose decode is still queued — a fast scroll keeps a few dozen of those
// in flight, and they hold raw bytes before they count as cached. Pure, so it
// is unit-tested in node (lib/localMemoryBudget.test.ts).

import { instanceImageCount, type LocalInstanceHeader } from "./localStudy";

/** Share of the device budget kept for reads in flight (file read, decode pending). */
export const IN_FLIGHT_HEADROOM = 0.25;

/** Never cap a study's decoded cache below this: it must hold a screenful of neighbours. */
export const MIN_LOCAL_DECODED_CACHE_BYTES = 48 * 1024 * 1024;

/** Decoded bytes of one frame, or null when the header lacks the geometry. */
export function decodedBytesPerFrame(header: LocalInstanceHeader): number | null {
  const { rows, columns } = header;
  if (!rows || !columns || rows <= 0 || columns <= 0) return null;
  const samples = header.samplesPerPixel && header.samplesPerPixel > 0 ? header.samplesPerPixel : 1;
  const bits = header.bitsAllocated && header.bitsAllocated > 0 ? header.bitsAllocated : 16;
  // Cornerstone decodes to typed arrays: 8-bit → 1 byte, 16-bit → 2, 32-bit → 4.
  const bytesPerSample = bits <= 8 ? 1 : bits <= 16 ? 2 : 4;
  return rows * columns * samples * bytesPerSample;
}

/**
 * Raw file bytes per decoded byte across a study (weighted by size, so a few
 * odd files cannot swing it). 1 for uncompressed, well under 1 for JPEG 2000.
 */
export function rawToDecodedRatio(headers: readonly LocalInstanceHeader[]): number {
  let raw = 0;
  let decoded = 0;
  for (const header of headers) {
    const perFrame = decodedBytesPerFrame(header);
    if (perFrame == null || !(header.sizeBytes > 0)) continue;
    raw += header.sizeBytes;
    decoded += perFrame * instanceImageCount(header);
  }
  // No usable geometry: assume the uncompressed worst case.
  if (decoded === 0) return 1;
  return Math.min(4, Math.max(0, raw / decoded));
}

/** The decoded-image cache cap that keeps decoded + raw inside `deviceBudgetBytes`. */
export function localDecodedCacheBudget(
  headers: readonly LocalInstanceHeader[],
  deviceBudgetBytes: number
): number {
  const ratio = rawToDecodedRatio(headers);
  const cap = Math.floor((deviceBudgetBytes * (1 - IN_FLIGHT_HEADROOM)) / (1 + ratio));
  return Math.max(Math.min(MIN_LOCAL_DECODED_CACHE_BYTES, deviceBudgetBytes), cap);
}
