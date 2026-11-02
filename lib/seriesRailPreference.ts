// Series-rail presentation preference.
//
// Collapsing the rail frees viewport width. It is local to this browser and
// must never gate imaging: Gemini Live `set_series` / `show_finding` switch
// the loaded viewport stack whether or not the list is on screen.

export const SERIES_RAIL_STORAGE_KEY = "radlearn.seriesRailOpen";

/**
 * Phone and portrait-tablet preference. Kept separate from the wide key so a
 * desktop "open" choice cannot force the rail over a narrow image.
 */
export const SERIES_RAIL_NARROW_STORAGE_KEY = "radlearn.seriesRailOpenNarrow";

/** Unmodified `[` toggles the rail. Shared by the viewer and the cheatsheet. */
export const SERIES_RAIL_TOGGLE_KEY = "[";

export interface SeriesRailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Missing or unrecognized values stay open so a corrupt entry cannot trap the rail shut. */
export function parseSeriesRailOpen(raw: string | null | undefined): boolean {
  return raw !== "0";
}

export function readSeriesRailOpen(storage: SeriesRailStorage | null | undefined): boolean {
  if (!storage) return true;
  try {
    return parseSeriesRailOpen(storage.getItem(SERIES_RAIL_STORAGE_KEY));
  } catch {
    return true;
  }
}

export function writeSeriesRailOpen(
  storage: SeriesRailStorage | null | undefined,
  open: boolean
): void {
  if (!storage) return;
  try {
    storage.setItem(SERIES_RAIL_STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* private mode or a full quota — the in-memory toggle still applies */
  }
}

export function seriesRailStorageKey(narrow: boolean): string {
  return narrow ? SERIES_RAIL_NARROW_STORAGE_KEY : SERIES_RAIL_STORAGE_KEY;
}

/**
 * Wide viewports stay open until the reader collapses them.
 * Narrow viewports start collapsed so the series list and the tutor drawer
 * cannot sit side by side and cover the image. An explicit "1" still reopens.
 */
export function readSeriesRailOpenForViewport(
  storage: SeriesRailStorage | null | undefined,
  narrow: boolean
): boolean {
  if (!narrow) return readSeriesRailOpen(storage);
  if (!storage) return false;
  try {
    return storage.getItem(SERIES_RAIL_NARROW_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSeriesRailOpenForViewport(
  storage: SeriesRailStorage | null | undefined,
  narrow: boolean,
  open: boolean
): void {
  if (!storage) return;
  try {
    storage.setItem(seriesRailStorageKey(narrow), open ? "1" : "0");
  } catch {
    /* private mode or a full quota — the in-memory toggle still applies */
  }
}

export interface SeriesRailLabelInput {
  open: boolean;
  series: ReadonlyArray<{ description?: string | null; seriesNumber?: number | null }>;
  activeIndex: number;
}

function activeSeriesName(
  series: SeriesRailLabelInput["series"],
  activeIndex: number
): string {
  const current = series[activeIndex];
  if (!current) return "";
  const description = current.description?.trim();
  if (description) return description;
  if (current.seriesNumber != null && Number.isFinite(current.seriesNumber)) {
    return `Series ${current.seriesNumber}`;
  }
  return "Series";
}

/** Accessible name for the single collapse / expand control. */
export function seriesRailToggleLabel(input: SeriesRailLabelInput): string {
  if (input.open) return "Collapse series list";
  if (input.series.length === 0) return "Expand series list";
  const count = `${input.series.length} series`;
  const name = activeSeriesName(input.series, input.activeIndex);
  return name ? `Expand series list, ${count}, showing ${name}` : `Expand series list, ${count}`;
}
