// ============================================================================
// lib/dicomCdn/windowing.ts  (isomorphic, pure)
//
// 8-bit previews at the series' default window, and the inverse the viewer
// uses to put a preview on screen in MODALITY units (HU on CT).
//
// Why modality units: the stack viewport keeps one VOI across slices. If a
// preview were handed over as 0–255 grey, the first full-quality frame would
// arrive under a 0–255 window and look blown out. Mapping each preview grey
// level back onto [lo, hi] of the window it was rendered at means the preview
// and the full frame look the same under the default window, and the swap is
// a sharpening, not a flash. Outside [lo, hi] the preview has no information —
// which is exactly why window/level is locked until the full frame lands.
// ============================================================================

export interface DicomWindow {
  center: number;
  width: number;
}

export interface PixelDescription {
  rows: number;
  columns: number;
  bitsAllocated: number;
  pixelRepresentation: number;
  samplesPerPixel: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  photometricInterpretation?: string;
  numberOfFrames: number;
}

type TagMap = Record<string, { Value?: unknown[] } | undefined>;

function firstNumber(meta: unknown, tag: string): number | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const raw = (meta as TagMap)[tag]?.Value?.[0];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function firstString(meta: unknown, tag: string): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const raw = (meta as TagMap)[tag]?.Value?.[0];
  return typeof raw === "string" ? raw.trim() || undefined : undefined;
}

/** Pixel module from a DICOM JSON dataset. Null when the image is not describable. */
export function describePixels(meta: unknown): PixelDescription | null {
  const rows = firstNumber(meta, "00280010");
  const columns = firstNumber(meta, "00280011");
  const bitsAllocated = firstNumber(meta, "00280100");
  if (!rows || !columns || !bitsAllocated) return null;
  return {
    rows,
    columns,
    bitsAllocated,
    pixelRepresentation: firstNumber(meta, "00280103") ?? 0,
    samplesPerPixel: firstNumber(meta, "00280002") ?? 1,
    rescaleSlope: firstNumber(meta, "00281053") ?? 1,
    rescaleIntercept: firstNumber(meta, "00281052") ?? 0,
    photometricInterpretation: firstString(meta, "00280004"),
    numberOfFrames: firstNumber(meta, "00280008") ?? 1,
  };
}

/** First Window Center / Width pair stored on the instance, when sane. */
export function storedWindow(meta: unknown): DicomWindow | undefined {
  const center = firstNumber(meta, "00281050");
  const width = firstNumber(meta, "00281051");
  if (center == null || width == null || !(width > 1)) return undefined;
  return { center, width };
}

/** Typed view over raw little-endian pixel bytes for one grey frame. */
export function rawPixelView(
  bytes: Uint8Array,
  desc: Pick<PixelDescription, "bitsAllocated" | "pixelRepresentation" | "rows" | "columns">
): Int16Array | Uint16Array | Uint8Array | Int8Array {
  const n = desc.rows * desc.columns;
  if (desc.bitsAllocated === 16) {
    if (bytes.byteLength < n * 2) throw new Error("Pixel data is shorter than the frame");
    // Copy when unaligned; typed arrays need 2-byte alignment.
    const aligned =
      bytes.byteOffset % 2 === 0 ? bytes : new Uint8Array(bytes.subarray(0, n * 2));
    return desc.pixelRepresentation === 1
      ? new Int16Array(aligned.buffer, aligned.byteOffset, n)
      : new Uint16Array(aligned.buffer, aligned.byteOffset, n);
  }
  if (desc.bitsAllocated === 8) {
    if (bytes.byteLength < n) throw new Error("Pixel data is shorter than the frame");
    return desc.pixelRepresentation === 1
      ? new Int8Array(bytes.buffer, bytes.byteOffset, n)
      : bytes.subarray(0, n);
  }
  throw new Error(`Unsupported BitsAllocated ${desc.bitsAllocated}`);
}

/**
 * Window from the frame itself when the header has none: the 1st–99th
 * percentile of modality values, from a strided sample (cheap on 2k² frames).
 */
export function percentileWindow(
  pixels: ArrayLike<number>,
  slope: number,
  intercept: number
): DicomWindow {
  const stride = Math.max(1, Math.floor(pixels.length / 65_536));
  const sample: number[] = [];
  for (let i = 0; i < pixels.length; i += stride) sample.push(pixels[i] * slope + intercept);
  if (sample.length === 0) return { center: 0, width: 1 };
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.01)];
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.99))];
  const width = Math.max(1, hi - lo);
  return { center: lo + width / 2, width };
}

/** Preview size: longest edge capped at `maxDim`, never upscaled. */
export function previewSize(rows: number, columns: number, maxDim: number): { w: number; h: number } {
  const scale = Math.min(1, maxDim / Math.max(rows, columns));
  return {
    w: Math.max(1, Math.round(columns * scale)),
    h: Math.max(1, Math.round(rows * scale)),
  };
}

export interface Preview8 {
  w: number;
  h: number;
  /** Grey levels, row-major, w*h. */
  data: Uint8Array;
  /** Modality-unit window the 0..255 range spans. */
  lo: number;
  hi: number;
}

/**
 * Downscale (area average) and window one grey frame to 8 bits.
 * Linear DICOM window (PS3.3 C.11.2.1.2.1 without the −0.5 nuance — this is a
 * preview, not a display). The window bounds travel with the preview so the
 * client can invert it exactly.
 */
export function renderPreview8(
  pixels: ArrayLike<number>,
  rows: number,
  columns: number,
  slope: number,
  intercept: number,
  window: DicomWindow,
  maxDim: number
): Preview8 {
  const { w, h } = previewSize(rows, columns, maxDim);
  const sums = new Float64Array(w * h);
  const counts = new Uint32Array(w * h);
  for (let y = 0; y < rows; y++) {
    const oy = Math.min(h - 1, Math.floor((y * h) / rows));
    const rowAt = y * columns;
    const outRow = oy * w;
    for (let x = 0; x < columns; x++) {
      const ox = Math.min(w - 1, Math.floor((x * w) / columns));
      sums[outRow + ox] += pixels[rowAt + x];
      counts[outRow + ox] += 1;
    }
  }
  const lo = window.center - window.width / 2;
  const hi = window.center + window.width / 2;
  const span = hi - lo || 1;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) {
    const stored = counts[i] ? sums[i] / counts[i] : 0;
    const value = stored * slope + intercept;
    const g = ((value - lo) / span) * 255;
    data[i] = g <= 0 ? 0 : g >= 255 ? 255 : Math.round(g);
  }
  return { w, h, data, lo, hi };
}

/**
 * Inverse of renderPreview8 at full size, as STORED pixel bytes.
 *
 * Nearest-neighbour upscale of the grey preview to rows×columns, each grey
 * level mapped back to the modality value it stood for, then un-rescaled to
 * the stored value the real frame would carry (stored = (value − intercept) /
 * slope), little-endian, at the frame's own BitsAllocated/PixelRepresentation.
 *
 * The viewer hands these bytes to Cornerstone's createImage as an
 * uncompressed frame — so a preview goes through the exact pipeline a real
 * frame does (rescale, VOI, MONOCHROME1, spacing, data type) and differs only
 * in being quantised. That is what makes the swap to full quality seamless.
 */
export function previewToStoredBytes(
  grey: ArrayLike<number>,
  w: number,
  h: number,
  desc: Pick<PixelDescription, "rows" | "columns" | "bitsAllocated" | "pixelRepresentation" | "rescaleSlope" | "rescaleIntercept">,
  lo: number,
  hi: number
): Uint8Array {
  const { rows, columns } = desc;
  const signed = desc.pixelRepresentation === 1;
  const slope = desc.rescaleSlope || 1;
  const intercept = desc.rescaleIntercept;
  const [min, max] =
    desc.bitsAllocated === 16 ? (signed ? [-32768, 32767] : [0, 65535]) : signed ? [-128, 127] : [0, 255];
  const lut = new Float64Array(256);
  for (let g = 0; g < 256; g++) {
    const value = lo + (g / 255) * (hi - lo);
    const stored = Math.round((value - intercept) / slope);
    lut[g] = stored < min ? min : stored > max ? max : stored;
  }
  const n = rows * columns;
  const out =
    desc.bitsAllocated === 16
      ? signed
        ? new Int16Array(n)
        : new Uint16Array(n)
      : signed
        ? new Int8Array(n)
        : new Uint8Array(n);
  for (let y = 0; y < rows; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / rows));
    for (let x = 0; x < columns; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / columns));
      out[y * columns + x] = lut[grey[sy * w + sx] | 0];
    }
  }
  // Typed arrays are platform-endian; every browser and Cloud Run is little-endian.
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
