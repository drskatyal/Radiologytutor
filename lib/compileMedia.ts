/**
 * Viewport stills for a teaching take.
 *
 * The student never sees these frames. They are a sparse strip of the imaging
 * surface sent with the microphone and the viewer log so Flash can hear and
 * see the take. Markers and slices are not read off the pixels — the track
 * clock still places those.
 *
 * Safe to import from client components. No Gemini key, no model id.
 */

import type { RecordedTrack } from "./types";

export const COMPILING_FROM_RECORDING = "Compiling from recording…";

/** How many stills a compile request may attach. */
export const COMPILE_FRAME_LIMIT = 8;
/** In-memory cap while the take is still running. */
export const VIEWPORT_STRIP_LIMIT = 24;
/** Reject stills larger than this so a take cannot blow the authoring body. */
export const COMPILE_FRAME_MAX_BASE64 = 90_000;
export const STILL_MAX_EDGE = 480;
export const VIEWPORT_SAMPLE_MS = 1500;
/**
 * Takes at least this long use agentic video understanding. Shorter recordings
 * stay on static frames plus the sparse still strip.
 */
export const AGENTIC_VIDEO_MIN_MS = 5 * 60 * 1000;

export function compileVideoProcessing(durationMs: number): "AGENTIC" | "STATIC" {
  return durationMs >= AGENTIC_VIDEO_MIN_MS ? "AGENTIC" : "STATIC";
}

const MIN_STILL_CHARS = 32;

export interface CompileFrame {
  tMs: number;
  mimeType: string;
  /** Raw base64, no `data:` prefix. */
  base64: string;
}

export type ViewportStillGrab =
  | { ok: true; mimeType: string; base64: string }
  | { ok: false; fatal: boolean };

export interface GrayscaleFrame {
  columns: number;
  rows: number;
  samples: ArrayLike<number>;
  slope: number;
  intercept: number;
  ww: number;
  wc: number;
  /** Flip after windowing (viewport invert, or MONOCHROME1). */
  invert?: boolean;
}

export function trackClockSummary(track: RecordedTrack | null | undefined): string {
  if (!track) return "";
  const lines = [`t=0ms slice ${track.start.sliceIndex}`];
  for (const event of track.events) {
    switch (event.type) {
      case "slice":
        lines.push(`t=${event.t}ms slice ${event.index}`);
        break;
      case "cursor":
        lines.push(`t=${event.t}ms pointer`);
        break;
      case "voi":
        lines.push(`t=${event.t}ms window`);
        break;
      case "camera":
        lines.push(`t=${event.t}ms camera`);
        break;
      case "invert":
        lines.push(`t=${event.t}ms invert`);
        break;
      case "series":
        lines.push(`t=${event.t}ms series`);
        break;
      case "annotation":
        lines.push(`t=${event.t}ms annotation`);
        break;
      case "compare":
        lines.push(`t=${event.t}ms compare`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

function normalizeMime(mime: string): string | null {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "image/jpg" || base === "image/jpeg") return "image/jpeg";
  if (base === "image/png" || base === "image/webp") return base;
  return null;
}

function normalizeBase64(data: string): string | null {
  const trimmed = data.trim();
  const comma = trimmed.indexOf(",");
  const payload = trimmed.startsWith("data:") && comma !== -1 ? trimmed.slice(comma + 1) : trimmed;
  const compact = payload.replace(/\s/g, "");
  if (compact.length < MIN_STILL_CHARS || compact.length > COMPILE_FRAME_MAX_BASE64) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  return compact;
}

/** Evenly spaced indexes, always including the first and last when `limit` > 1. */
export function sampleIndices(count: number, limit: number): number[] {
  if (count <= 0 || limit <= 0) return [];
  if (count <= limit) return Array.from({ length: count }, (_, i) => i);
  const picked = new Set<number>();
  const last = count - 1;
  const denom = Math.max(1, limit - 1);
  for (let i = 0; i < limit; i++) picked.add(Math.round((i * last) / denom));
  let cursor = 0;
  while (picked.size < limit && picked.size < count) {
    picked.add(cursor);
    cursor += 1;
  }
  return [...picked].sort((a, b) => a - b);
}

export function prepareCompileFrames(
  frames: CompileFrame[] | null | undefined,
  limit = COMPILE_FRAME_LIMIT
): CompileFrame[] {
  if (!frames?.length) return [];
  const cleaned: CompileFrame[] = [];
  for (const frame of frames) {
    const mimeType = normalizeMime(frame?.mimeType ?? "");
    const base64 = typeof frame?.base64 === "string" ? normalizeBase64(frame.base64) : null;
    const tMs = Number(frame?.tMs);
    if (!mimeType || !base64 || !Number.isFinite(tMs)) continue;
    cleaned.push({ tMs: Math.max(0, Math.round(tMs)), mimeType, base64 });
  }
  cleaned.sort((a, b) => a.tMs - b.tMs);
  const unique: CompileFrame[] = [];
  for (const frame of cleaned) {
    const prev = unique[unique.length - 1];
    if (prev && prev.tMs === frame.tMs) unique[unique.length - 1] = frame;
    else unique.push(frame);
  }
  return sampleIndices(unique.length, limit).map((index) => unique[index]!);
}

export function pushViewportStill(frames: CompileFrame[], next: CompileFrame): CompileFrame[] {
  return prepareCompileFrames([...frames, next], VIEWPORT_STRIP_LIMIT);
}

export function coerceCompileFrames(raw: unknown): CompileFrame[] {
  if (!Array.isArray(raw)) return [];
  const frames: CompileFrame[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    frames.push({
      tMs: Number(row.tMs),
      mimeType:
        typeof row.mimeType === "string" ? row.mimeType : typeof row.mime === "string" ? row.mime : "",
      base64: typeof row.base64 === "string" ? row.base64 : "",
    });
  }
  return prepareCompileFrames(frames);
}

export function largestCanvas<T extends { width: number; height: number }>(
  canvases: ArrayLike<T>
): T | null {
  let best: T | null = null;
  let area = 0;
  for (let i = 0; i < canvases.length; i++) {
    const canvas = canvases[i]!;
    const next = Math.max(0, canvas.width) * Math.max(0, canvas.height);
    if (next > area) {
      best = canvas;
      area = next;
    }
  }
  return best;
}

export function fitEdge(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  if (width < 2 || height < 2 || maxEdge < 2) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** True when a snapshot has tonal range. A cleared WebGL buffer is uniform. */
export function snapshotHasDetail(pixels: ArrayLike<number>, step = 16): boolean {
  let min = 255;
  let max = 0;
  let n = 0;
  const stride = Math.max(1, step) * 4;
  for (let i = 0; i + 3 < pixels.length; i += stride) {
    if (pixels[i + 3] < 8) continue;
    const lum = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    n += 1;
  }
  return n >= 2 && max - min >= 8;
}

/**
 * Window stored pixels into a fitted RGBA buffer.
 * Coordinates are not produced — this is only a picture of the slice.
 */
export function rasterizeGrayscale(
  frame: GrayscaleFrame,
  maxEdge = STILL_MAX_EDGE
): Uint8ClampedArray | null {
  const columns = Math.floor(frame.columns);
  const rows = Math.floor(frame.rows);
  if (columns < 1 || rows < 1) return null;
  if (frame.samples.length < columns * rows) return null;
  if (!Number.isFinite(frame.ww) || frame.ww <= 0 || !Number.isFinite(frame.wc)) return null;
  const slope = Number.isFinite(frame.slope) ? frame.slope : 1;
  const intercept = Number.isFinite(frame.intercept) ? frame.intercept : 0;
  const fit =
    columns <= maxEdge && rows <= maxEdge
      ? { width: columns, height: rows }
      : fitEdge(columns, rows, maxEdge);
  if (fit.width < 1 || fit.height < 1) return null;
  const rgba = new Uint8ClampedArray(fit.width * fit.height * 4);
  const xScale = columns / fit.width;
  const yScale = rows / fit.height;
  const lower = frame.wc - frame.ww / 2;
  const upper = frame.wc + frame.ww / 2;
  for (let y = 0; y < fit.height; y++) {
    const sy = Math.min(rows - 1, Math.floor(y * yScale));
    for (let x = 0; x < fit.width; x++) {
      const sx = Math.min(columns - 1, Math.floor(x * xScale));
      const stored = Number(frame.samples[sy * columns + sx] ?? 0);
      const value = stored * slope + intercept;
      let gray = 0;
      if (value >= upper) gray = 255;
      else if (value > lower) gray = Math.round(((value - lower) / frame.ww) * 255);
      if (frame.invert) gray = 255 - gray;
      const offset = (y * fit.width + x) * 4;
      rgba[offset] = gray;
      rgba[offset + 1] = gray;
      rgba[offset + 2] = gray;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function jpegDataUrlPayload(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  return normalizeBase64(dataUrl.slice(comma + 1));
}

export function jpegBase64FromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  quality = 0.62
): string | null {
  if (typeof document === "undefined" || width < 1 || height < 1) return null;
  if (rgba.length < width * height * 4) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const copy = new Uint8ClampedArray(rgba);
    ctx.putImageData(new ImageData(copy, width, height), 0, 0);
    return jpegDataUrlPayload(canvas.toDataURL("image/jpeg", quality));
  } catch {
    return null;
  }
}

export function jpegStillFromGrayscale(
  frame: GrayscaleFrame
): { mimeType: string; base64: string } | null {
  const rgba = rasterizeGrayscale(frame);
  if (!rgba) return null;
  const columns = Math.floor(frame.columns);
  const rows = Math.floor(frame.rows);
  const fit =
    columns <= STILL_MAX_EDGE && rows <= STILL_MAX_EDGE
      ? { width: columns, height: rows }
      : fitEdge(columns, rows, STILL_MAX_EDGE);
  const base64 = jpegBase64FromRgba(rgba, fit.width, fit.height);
  if (!base64) return null;
  return { mimeType: "image/jpeg", base64 };
}

/**
 * Read the on-screen imaging canvas. A tainted or cleared WebGL buffer
 * returns a non-fatal miss so the caller can fall back to pixel data.
 * Never calls getContext on `source` — that would steal Cornerstone's context.
 */
export function stillFromCanvas(source: HTMLCanvasElement, maxEdge = STILL_MAX_EDGE): ViewportStillGrab {
  if (source.width < 2 || source.height < 2) return { ok: false, fatal: false };
  const fit = fitEdge(source.width, source.height, maxEdge);
  if (fit.width < 2 || fit.height < 2) return { ok: false, fatal: false };
  try {
    const out = document.createElement("canvas");
    out.width = fit.width;
    out.height = fit.height;
    const ctx = out.getContext("2d");
    if (!ctx) return { ok: false, fatal: true };
    ctx.drawImage(source, 0, 0, fit.width, fit.height);
    let pixels: Uint8ClampedArray;
    try {
      pixels = ctx.getImageData(0, 0, fit.width, fit.height).data;
    } catch {
      return { ok: false, fatal: true };
    }
    if (!snapshotHasDetail(pixels)) return { ok: false, fatal: false };
    const base64 = jpegDataUrlPayload(out.toDataURL("image/jpeg", 0.62));
    if (!base64) return { ok: false, fatal: false };
    return { ok: true, mimeType: "image/jpeg", base64 };
  } catch {
    return { ok: false, fatal: true };
  }
}
