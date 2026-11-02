// Series thumbnails for the local (no-upload) viewer — the pure half.
//
// A thumbnail is the series' middle image, shown with the series' own default
// window (the file's Window Center / Width, else the image's range), box-
// filtered down to THUMB_EDGE px and stored as a small JPEG. Decoding is the
// engine's (its decode workers); this module holds the maths every step needs
// so it is unit-tested in node:
//
//   pixel data ──sampleForThumb──▶ ≤ SAMPLE_EDGE grid of modality values (main,
//   strided, cheap) ──renderThumbRgba──▶ THUMB_EDGE RGBA (thumbnail worker:
//   window, invert, box filter) ──▶ JPEG (worker OffscreenCanvas)
//
// Thumbnails cost memory like every other image, so they live in a byte-
// capped LRU (ThumbnailCache) and THUMB_BUDGET_BYTES is taken out of the
// study's decoded-image budget (localMemoryBudget.ts).

/** Longest edge of a stored thumbnail, px (2× the ~56 px card on a 2× screen). */
export const THUMB_EDGE = 128;

/** Longest edge of the grid sampled on the main thread before the worker filters it. */
export const SAMPLE_EDGE = 256;

/** All thumbnails of a study together (JPEG bytes). ~6 KB each → ~170 series. */
export const THUMB_BUDGET_BYTES = 1024 * 1024;

/** The middle image of a series (its imageIds in display order), or null. */
export function thumbnailImageId(imageIds: readonly string[]): string | null {
  if (imageIds.length === 0) return null;
  return imageIds[Math.floor((imageIds.length - 1) / 2)] ?? null;
}

export interface ThumbSample {
  width: number;
  height: number;
  /** 1 (greyscale, modality values) or 3 (RGB, 0–255). */
  channels: 1 | 3;
  values: Float32Array;
}

export interface PixelSource {
  pixelData: ArrayLike<number>;
  columns: number;
  rows: number;
  /** Samples per pixel in `pixelData` (1 grey, 3 RGB, 4 RGBA). */
  components: number;
  slope?: number;
  intercept?: number;
}

/**
 * Nearest-neighbour sample of the image onto a grid no bigger than `maxEdge`
 * (aspect kept), as modality values (slope / intercept applied). Colour keeps
 * three channels. Strided reads only: a 2k × 2k radiograph costs 64k reads.
 */
export function sampleForThumb(src: PixelSource, maxEdge = SAMPLE_EDGE): ThumbSample | null {
  const { columns, rows, pixelData } = src;
  if (!(columns > 0) || !(rows > 0)) return null;
  const comps = Math.max(1, Math.round(src.components || 1));
  if (pixelData.length < columns * rows * comps) return null;
  const scale = Math.min(1, maxEdge / Math.max(columns, rows));
  const width = Math.max(1, Math.round(columns * scale));
  const height = Math.max(1, Math.round(rows * scale));
  const channels: 1 | 3 = comps >= 3 ? 3 : 1;
  const slope = channels === 1 && Number.isFinite(src.slope) && src.slope ? src.slope : 1;
  const intercept = channels === 1 && Number.isFinite(src.intercept) ? (src.intercept as number) : 0;
  const values = new Float32Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(rows - 1, Math.floor(((y + 0.5) * rows) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(columns - 1, Math.floor(((x + 0.5) * columns) / width));
      const at = (sy * columns + sx) * comps;
      const out = (y * width + x) * channels;
      if (channels === 1) values[out] = Number(pixelData[at]) * slope + intercept;
      else {
        values[out] = Number(pixelData[at]);
        values[out + 1] = Number(pixelData[at + 1]);
        values[out + 2] = Number(pixelData[at + 2]);
      }
    }
  }
  return { width, height, channels, values };
}

export interface ThumbWindow {
  ww: number;
  wc: number;
}

/** First finite number of a DICOM value that may be multi-valued. */
function first(v: unknown): number | null {
  const n = Array.isArray(v) ? Number(v[0]) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The series' default window: the file's Window Center / Width when present
 * (the image the reader opens shows exactly this), else the sample's range.
 */
export function defaultThumbWindow(
  sample: ThumbSample,
  fileWindow?: { windowCenter?: unknown; windowWidth?: unknown } | null
): ThumbWindow {
  const wc = first(fileWindow?.windowCenter);
  const ww = first(fileWindow?.windowWidth);
  if (wc != null && ww != null && ww > 0) return { ww, wc };
  if (sample.channels === 3) return { ww: 256, wc: 128 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of sample.values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || hi <= lo) return { ww: 1, wc: Number.isFinite(lo) ? lo : 0 };
  return { ww: hi - lo, wc: (hi + lo) / 2 };
}

export interface ThumbRgba {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/**
 * Window (linear, DICOM C.11.2.1.2), invert (MONOCHROME1) and box-filter the
 * sample down to `edge` px on its longest side. Colour images are averaged
 * only. Output is opaque RGBA, ready for ImageData.
 */
export function renderThumbRgba(sample: ThumbSample, win: ThumbWindow, invert = false, edge = THUMB_EDGE): ThumbRgba {
  const { width: sw, height: sh, channels, values } = sample;
  const scale = Math.min(1, edge / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const ww = Math.max(1, win.ww);
  const lower = win.wc - 0.5 - (ww - 1) / 2;
  const span = ww - 1 || 1;
  const grey = (v: number) => {
    const g = v <= lower ? 0 : v > lower + span ? 255 : ((v - lower) / span) * 255;
    return invert ? 255 - g : g;
  };
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * sh) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * sw) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const at = (yy * sw + xx) * channels;
          if (channels === 1) {
            const v = grey(values[at]!);
            r += v;
            g += v;
            b += v;
          } else {
            r += values[at]!;
            g += values[at + 1]!;
            b += values[at + 2]!;
          }
          n += 1;
        }
      }
      const out = (y * width + x) * 4;
      rgba[out] = r / n;
      rgba[out + 1] = g / n;
      rgba[out + 2] = b / n;
      rgba[out + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Thumbnails of the open study: a byte-capped LRU of object URLs. Eviction
 * and `clear` revoke the URL (the Blob is then collectable), so the cap is
 * the real memory held. `revoke` is injected for tests.
 */
export class ThumbnailCache {
  private entries = new Map<string, { url: string; bytes: number }>();
  private total = 0;

  constructor(
    private readonly capBytes = THUMB_BUDGET_BYTES,
    private readonly revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)
  ) {}

  get(key: string): string | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.url;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, url: string, bytes: number): void {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.total -= old.bytes;
      if (old.url !== url) this.revoke(old.url);
    }
    this.entries.set(key, { url, bytes });
    this.total += bytes;
    for (const [k, e] of this.entries) {
      if (this.total <= this.capBytes || k === key) break;
      this.entries.delete(k);
      this.total -= e.bytes;
      this.revoke(e.url);
    }
  }

  bytes(): number {
    return this.total;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    for (const e of this.entries.values()) this.revoke(e.url);
    this.entries.clear();
    this.total = 0;
  }
}
