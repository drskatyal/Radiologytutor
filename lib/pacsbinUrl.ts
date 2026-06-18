// ============================================================================
// lib/pacsbinUrl.ts
//
// The ONLY place that knows how Pacsbin encodes viewport state in URLs.
// Everything Pacsbin-specific lives here so a future viewer (Cornerstone3D,
// LiteVNA, etc.) can replace it without touching the UI or the data model.
//
// Pacsbin controls are one-way: we SET viewport state by changing URL query
// params. There is no way to read state back out of the iframe. So:
//   - buildViewerUrl(): emit a URL that locks a given viewport + chrome state.
//   - parseViewportFromUrl(): reverse-parse a Pacsbin "bookmark / link-to-image"
//     URL (which the tutor pastes) into our Viewport model.
//
// Param convention (per viewport index, 1-based):
//   s:1, i:1, ww:1, wc:1, scale:1, translation:1   and   layout=rowsxcols
// ============================================================================

import type { Viewport } from "./types";

/** Display chrome params. On playback we strip everything; in authoring we
 * keep the toolbar so the tutor can navigate. */
export interface ChromeOptions {
  header?: boolean;
  caseNavigation?: boolean;
  seriesList?: boolean;
  titles?: boolean;
  caseData?: boolean;
  toolbar?: boolean;
}

/** Clean playback chrome: strip all Pacsbin UI. */
export const PLAYBACK_CHROME: ChromeOptions = {
  header: false,
  caseNavigation: false,
  seriesList: false,
  titles: false,
  caseData: false,
  toolbar: false,
};

/** Authoring chrome: keep the toolbar so the tutor can scroll/window/zoom. */
export const AUTHOR_CHROME: ChromeOptions = {
  header: false,
  caseNavigation: false,
  seriesList: true,
  titles: false,
  caseData: false,
  toolbar: true,
};

const VIEWPORT_PARAM_KEYS = ["s", "i", "ww", "wc", "scale", "translation"] as const;

function num(value: string | null): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Reverse-parse a Pacsbin bookmark URL into a Viewport.
 * Tolerant: ignores params it doesn't recognise, handles missing optional
 * fields, and reads up to two viewports (for compare layouts).
 */
export function parseViewportFromUrl(url: string): Viewport {
  const params = extractParams(url);

  const layout = params.get("layout") ?? "1x1";

  const viewport: Viewport = {
    layout,
    s1: params.get("s:1") ?? "",
    i1: params.get("i:1") ?? "",
    ww1: num(params.get("ww:1")),
    wc1: num(params.get("wc:1")),
    scale1: num(params.get("scale:1")),
    translation1: params.get("translation:1") ?? undefined,
  };

  // Second viewport (compare). Only attach if present.
  const s2 = params.get("s:2");
  if (s2) {
    viewport.s2 = s2;
    viewport.i2 = params.get("i:2") ?? "";
    viewport.ww2 = num(params.get("ww:2"));
    viewport.wc2 = num(params.get("wc:2"));
    viewport.scale2 = num(params.get("scale:2"));
    viewport.translation2 = params.get("translation:2") ?? undefined;
  }

  return viewport;
}

/** Extract the base viewer URL (origin + path, no query) from any Pacsbin URL. */
export function parseBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    // Fall back to chopping at the first "?".
    return url.split("?")[0];
  }
}

/**
 * Build a Pacsbin viewer URL that locks the given viewport and chrome state.
 * Only emits viewport params that are defined, so partial viewports (e.g. a
 * bookmark without scale/translation) round-trip cleanly.
 */
export function buildViewerUrl(
  baseUrl: string,
  viewport: Viewport,
  chrome: ChromeOptions = {}
): string {
  const params = new URLSearchParams();

  params.set("layout", viewport.layout || "1x1");

  appendViewport(params, 1, {
    s: viewport.s1,
    i: viewport.i1,
    ww: viewport.ww1,
    wc: viewport.wc1,
    scale: viewport.scale1,
    translation: viewport.translation1,
  });

  if (viewport.s2) {
    appendViewport(params, 2, {
      s: viewport.s2,
      i: viewport.i2,
      ww: viewport.ww2,
      wc: viewport.wc2,
      scale: viewport.scale2,
      translation: viewport.translation2,
    });
  }

  for (const [key, value] of Object.entries(chrome)) {
    if (value !== undefined) params.set(key, String(value));
  }

  const base = parseBaseUrl(baseUrl);
  return `${base}?${decodeParams(params)}`;
}

interface ViewportSlot {
  s?: string;
  i?: string;
  ww?: number;
  wc?: number;
  scale?: number;
  translation?: string;
}

function appendViewport(params: URLSearchParams, index: number, slot: ViewportSlot) {
  if (slot.s) params.set(`s:${index}`, slot.s);
  if (slot.i) params.set(`i:${index}`, slot.i);
  if (slot.ww !== undefined) params.set(`ww:${index}`, String(slot.ww));
  if (slot.wc !== undefined) params.set(`wc:${index}`, String(slot.wc));
  if (slot.scale !== undefined) params.set(`scale:${index}`, String(slot.scale));
  if (slot.translation) params.set(`translation:${index}`, slot.translation);
}

/**
 * URLSearchParams percent-encodes the ":" in our keys and the "," in
 * translation. Pacsbin expects those literal, so decode them back. Other
 * values stay encoded.
 */
function decodeParams(params: URLSearchParams): string {
  return params
    .toString()
    .replace(/%3A/gi, ":")
    .replace(/%2C/gi, ",");
}

function extractParams(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams;
  } catch {
    const qIndex = url.indexOf("?");
    return new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : url);
  }
}

/**
 * Convenience: replace ONLY the slice (i:index) on an existing built URL.
 * Used by the animation runner to step through slices cheaply without
 * rebuilding the whole viewport each frame.
 */
export function withSlice(url: string, sliceId: string, index = 1): string {
  return replaceParam(url, `i:${index}`, sliceId);
}

/** Replace ONLY window width/center on an existing URL. */
export function withWindow(url: string, ww: number, wc: number, index = 1): string {
  return replaceParam(replaceParam(url, `ww:${index}`, String(ww)), `wc:${index}`, String(wc));
}

/** Replace ONLY scale + translation on an existing URL. */
export function withZoomPan(url: string, scale: number, translation: string, index = 1): string {
  return replaceParam(
    replaceParam(url, `scale:${index}`, String(scale)),
    `translation:${index}`,
    translation
  );
}

function replaceParam(url: string, key: string, value: string): string {
  const [base, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  params.set(key, value);
  return `${base}?${decodeParams(params)}`;
}
