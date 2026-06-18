// ============================================================================
// lib/pacsbinUrl.ts
//
// The ONLY place that knows how Pacsbin 2.0 encodes viewer state in URLs.
// Swap this module to retarget another viewer (e.g. self-hosted Cornerstone3D)
// without touching the UI or data model.
//
// Pacsbin 2.0 (Vue + Cornerstone3D) serializes the whole viewer as ONE object
//   { viewMode, layout:[rows,cols], viewports:[{seriesId, instanceId, ww, wc,
//     zoom, pan, viewUp, viewPlaneNormal, focalPoint, ...}] }
// into the `state` query param as: gzip(JSON) -> base64url.
//
// We CANNOT read state out of the cross-origin iframe, so the tutor pastes a
// Pacsbin URL and we keep its `state` blob VERBATIM (lossless, no re-encoding
// needed to replay). decode/encode are provided for inspection + synthesis.
// ============================================================================

import type { ViewerState } from "./types";

/** Display chrome params seen on real Pacsbin 2.0 URLs. */
export interface ChromeOptions {
  header?: boolean;
  caseData?: boolean;
  /** `an` = native annotations (we draw our own marker, so hide on playback). */
  an?: boolean;
  overlay?: boolean;
  title?: boolean;
}

/** Clean playback chrome: strip Pacsbin UI + native annotations. */
export const PLAYBACK_CHROME: ChromeOptions = {
  header: false,
  caseData: false,
  an: false,
  overlay: false,
  title: false,
};

/** Authoring chrome: keep the header/tools so the tutor can navigate. */
export const AUTHOR_CHROME: ChromeOptions = {
  header: true,
  caseData: true,
  an: true,
  overlay: true,
  title: true,
};

export interface ParsedUrl {
  baseUrl: string;
  /** Encoded `state` param verbatim (may be empty if none present). */
  state: string;
  chrome: ChromeOptions;
}

/** Pull the base viewer URL, the encoded `state`, and chrome flags out of a
 * pasted Pacsbin URL. Tolerant of missing pieces. */
export function parsePacsbinUrl(url: string): ParsedUrl {
  const { params, base } = splitUrl(url);
  const boolOf = (k: string): boolean | undefined => {
    const v = params.get(k);
    if (v == null) return undefined;
    return v === "true" || v === "1";
  };
  return {
    baseUrl: base,
    state: params.get("state") ?? "",
    chrome: {
      header: boolOf("header"),
      caseData: boolOf("caseData"),
      an: boolOf("an"),
      overlay: boolOf("overlay"),
      title: boolOf("title"),
    },
  };
}

/** Just the encoded `state` blob from a pasted URL ("" if none). */
export function extractState(url: string): string {
  return parsePacsbinUrl(url).state;
}

/** Base viewer URL (origin + path, no query). */
export function parseBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

/**
 * Build a viewer URL that loads a given encoded `state` with chrome flags.
 * `state` is Pacsbin's base64url blob (already URL-safe) — emitted verbatim.
 */
export function buildViewerUrl(
  baseUrl: string,
  state: string,
  chrome: ChromeOptions = {}
): string {
  const base = parseBaseUrl(baseUrl);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(chrome)) {
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  if (state) parts.push(`state=${state}`);
  return parts.length ? `${base}?${parts.join("&")}` : base;
}

// ---------------------------------------------------------------------------
// Encode / decode the `state` blob.  gzip(JSON) <-> base64url, isomorphic via
// the Web Streams Compression API (browser + Node 18+).
// ---------------------------------------------------------------------------

export async function decodeState(stateParam: string): Promise<ViewerState> {
  const bytes = base64urlToBytes(stateParam);
  const json = await gunzip(bytes);
  return JSON.parse(json) as ViewerState;
}

export async function encodeState(state: ViewerState): Promise<string> {
  const gz = await gzip(JSON.stringify(state));
  return bytesToBase64url(gz);
}

/** One-line human summary of a decoded state, for AI context / display. */
export function summarizeState(state: ViewerState): string {
  const [rows, cols] = state.layout ?? [1, 1];
  const panes = state.viewports
    .map((v, i) => {
      const wl = v.ww != null ? ` W/L ${Math.round(v.ww)}/${Math.round(v.wc ?? 0)}` : "";
      const z = v.zoom != null ? ` zoom ${v.zoom.toFixed(2)}` : "";
      return `pane ${i}: series ${short(v.seriesId)} slice ${short(v.instanceId)}${wl}${z}`;
    })
    .join("; ");
  return `${rows}x${cols} ${state.viewMode ?? "grid"} — ${panes}`;
}

function short(id?: string): string {
  return id ? `…${id.slice(-6)}` : "?";
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function splitUrl(url: string): { params: URLSearchParams; base: string } {
  try {
    const u = new URL(url);
    return { params: u.searchParams, base: `${u.origin}${u.pathname}` };
  } catch {
    const qIndex = url.indexOf("?");
    const query = qIndex >= 0 ? url.slice(qIndex + 1) : "";
    return { params: new URLSearchParams(query), base: url.split("?")[0] };
  }
}

function base64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function bytesToBase64url(bytes: Uint8Array): string {
  let b64: string;
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    b64 = btoa(bin);
  } else {
    b64 = Buffer.from(bytes).toString("base64");
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(ds));
  return stream.text();
}

async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Response(
    new Blob([text]).stream().pipeThrough(cs)
  );
  const buf = await stream.arrayBuffer();
  return new Uint8Array(buf);
}
