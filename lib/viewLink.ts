// "Link to this view" — the exact image a reader is looking at, as a URL.
//
// Pacsbin's best habit: a share link opens on the image the sender meant, not
// on slice 1 of series 1. The standalone viewer (`/case/[id]?mode=view` and
// `/s/[token]`) reads these query params on open and writes them when the
// reader copies a view link.
//
// Only view state goes in the URL: series UID, 1-based image number, window,
// and the hanging layout. Never a patient field, and never an access grant —
// the share token (or the reader's session) is still what authorizes pixels.

import type { HangingLayoutId } from "./hangingLayout";

export interface ViewLinkState {
  seriesInstanceUID?: string;
  /** 1-based, as the overlay prints it. */
  image?: number;
  ww?: number;
  wc?: number;
  layout?: HangingLayoutId;
}

const UID_RE = /^[0-9]+(\.[0-9]+)*$/;
const LAYOUTS: HangingLayoutId[] = ["1x1", "1x2", "2x1", "2x2"];

type ParamsLike = { get(name: string): string | null };

function toInt(value: string | null, min: number, max: number): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

/** Parse untrusted query params. Anything malformed is dropped, not guessed. */
export function parseViewLink(params: ParamsLike | Record<string, string | undefined>): ViewLinkState {
  const get = (name: string): string | null =>
    typeof (params as ParamsLike).get === "function"
      ? (params as ParamsLike).get(name)
      : ((params as Record<string, string | undefined>)[name] ?? null);
  const out: ViewLinkState = {};
  const series = get("series")?.trim();
  if (series && series.length <= 64 && UID_RE.test(series)) out.seriesInstanceUID = series;
  const image = toInt(get("im"), 1, 100_000);
  if (image != null) out.image = image;
  const ww = toInt(get("ww"), 1, 100_000);
  const wc = toInt(get("wc"), -100_000, 100_000);
  if (ww != null && wc != null) {
    out.ww = ww;
    out.wc = wc;
  }
  const layout = get("layout");
  if (layout && (LAYOUTS as string[]).includes(layout)) out.layout = layout as HangingLayoutId;
  return out;
}

/** Query string (no leading `?`) for a view. Stable key order. */
export function viewLinkQuery(state: ViewLinkState): string {
  const params = new URLSearchParams();
  if (state.seriesInstanceUID && UID_RE.test(state.seriesInstanceUID)) {
    params.set("series", state.seriesInstanceUID);
  }
  if (state.image != null && Number.isFinite(state.image) && state.image >= 1) {
    params.set("im", String(Math.round(state.image)));
  }
  if (
    state.ww != null &&
    state.wc != null &&
    Number.isFinite(state.ww) &&
    Number.isFinite(state.wc) &&
    state.ww >= 1
  ) {
    params.set("ww", String(Math.round(state.ww)));
    params.set("wc", String(Math.round(state.wc)));
  }
  if (state.layout && state.layout !== "1x1") params.set("layout", state.layout);
  return params.toString();
}

/**
 * Absolute URL for a view of `basePath`. Keeps the `mode=view` the case route
 * needs and replaces any view params already on it.
 */
export function viewLinkUrl(origin: string, basePath: string, state: ViewLinkState): string {
  const url = new URL(basePath, origin);
  for (const key of ["series", "im", "ww", "wc", "layout"]) url.searchParams.delete(key);
  const extra = new URLSearchParams(viewLinkQuery(state));
  extra.forEach((value, key) => url.searchParams.set(key, value));
  return url.toString();
}
