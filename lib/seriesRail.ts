// Series-rail counts and cover slices.
//
// Google Cloud Healthcare QIDO never returns NumberOfSeriesRelatedInstances
// (0020,1209), so a series header's instanceCount is 0 on the live archive.
// A parallel `instances?limit=1` lookup is not a middle slice, and it runs
// while the case page is still resolving series headers — before WADO-RS
// series metadata exists. The viewer later loads that metadata and paints
// the stack; the rail used to ignore it and stay on "0 images" with no cover.
//
// Counts come from an instance list (prefetch manifest, or a QIDO/metadata
// read that starts only after the main viewport has its first image). The
// cover is the middle instance, the same index the stack opens on. The
// rendered JPEG is not requested until that first image is up, so the rail
// cannot compete with first pixels.

import { stackOpenIndex } from "./stackIndex";
import { BUNDLED_STUDY_UID, type CaseSeries } from "./viewerSource";

export interface RailStats {
  instanceCount: number;
  /** SOP Instance UID of the middle slice. Absent when the series is empty. */
  thumbnailInstanceUID?: string;
}

export interface RailInstance {
  sopInstanceUID: string;
  instanceNumber?: number;
}

/** One series whose instances were already listed (prefetch manifest). */
export interface RailInstanceSource {
  seriesInstanceUID: string;
  instances?: readonly RailInstance[];
}

export interface RailEntry extends CaseSeries {
  /** Count is not known yet. The row must not say "0 images". */
  countPending?: boolean;
  /** Cover is intentionally withheld or still loading. Show a spinner, not a broken image. */
  thumbPending?: boolean;
}

interface DicomElement {
  Value?: unknown[];
}

function tagValue(row: unknown, tag: string): unknown {
  if (!row || typeof row !== "object") return undefined;
  const element = (row as Record<string, DicomElement>)[tag];
  return element?.Value?.[0];
}

function tagString(row: unknown, tag: string): string | undefined {
  const raw = tagValue(row, tag);
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function tagNumber(row: unknown, tag: string): number | undefined {
  const text = tagString(row, tag);
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Count and middle SOP from an instance list.
 * When every row has an InstanceNumber, order is anatomical (not QIDO arrival
 * order). Otherwise the list order is kept — that is the order WADO metadata
 * and the viewer stack use.
 */
export function railStatsFromInstances(instances: readonly RailInstance[]): RailStats {
  const rows = instances.filter((item) => item.sopInstanceUID.trim());
  const numbered = rows.length > 0 && rows.every((item) => typeof item.instanceNumber === "number");
  const ordered = numbered
    ? [...rows].sort(
        (a, b) =>
          (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0) ||
          a.sopInstanceUID.localeCompare(b.sopInstanceUID)
      )
    : rows;
  const middle = ordered[stackOpenIndex(ordered.length)];
  return {
    instanceCount: ordered.length,
    thumbnailInstanceUID: middle?.sopInstanceUID,
  };
}

/** DICOM JSON from QIDO instance search or WADO-RS series metadata. */
export function railStatsFromDicomJson(rows: unknown): RailStats {
  if (!Array.isArray(rows)) return { instanceCount: 0 };
  const instances: RailInstance[] = [];
  for (const row of rows) {
    const sop = tagString(row, "00080018");
    if (!sop) continue;
    const instanceNumber = tagNumber(row, "00200013");
    instances.push(
      instanceNumber == null ? { sopInstanceUID: sop } : { sopInstanceUID: sop, instanceNumber }
    );
  }
  return railStatsFromInstances(instances);
}

export function railStatsBySeries(
  entries: readonly RailInstanceSource[] | null | undefined
): Record<string, RailStats> {
  const out: Record<string, RailStats> = {};
  for (const entry of entries ?? []) {
    if (!entry.seriesInstanceUID || !entry.instances || entry.instances.length === 0) continue;
    const stats = railStatsFromInstances(entry.instances);
    if (stats.instanceCount > 0) out[entry.seriesInstanceUID] = stats;
  }
  return out;
}

export function isBundledSeries(series: Pick<CaseSeries, "studyInstanceUID">): boolean {
  return series.studyInstanceUID === BUNDLED_STUDY_UID;
}

/** Rendered middle-slice JPEG. 96px is the rail slot; the browser scales it with object-cover. */
export function seriesThumbUrl(
  series: Pick<CaseSeries, "wadoRsRoot" | "studyInstanceUID" | "seriesInstanceUID" | "thumbnailInstanceUID">
): string | null {
  if (!series.thumbnailInstanceUID) return null;
  return (
    `${series.wadoRsRoot}/studies/${encodeURIComponent(series.studyInstanceUID)}` +
    `/series/${encodeURIComponent(series.seriesInstanceUID)}` +
    `/instances/${encodeURIComponent(series.thumbnailInstanceUID)}/rendered?viewport=96,96`
  );
}

/** QIDO-RS instance search. includefield names SOP and InstanceNumber so a store that replaces the default set still returns both. */
export function seriesInstanceSearchUrl(
  series: Pick<CaseSeries, "wadoRsRoot" | "studyInstanceUID" | "seriesInstanceUID">,
  offset = 0,
  limit = 2000
): string {
  const query = new URLSearchParams({
    includefield: "00080018,00200013",
    limit: String(limit),
    offset: String(offset),
  });
  return (
    `${series.wadoRsRoot}/studies/${encodeURIComponent(series.studyInstanceUID)}` +
    `/series/${encodeURIComponent(series.seriesInstanceUID)}/instances?${query}`
  );
}

export function seriesMetadataUrl(
  series: Pick<CaseSeries, "wadoRsRoot" | "studyInstanceUID" | "seriesInstanceUID">
): string {
  return (
    `${series.wadoRsRoot}/studies/${encodeURIComponent(series.studyInstanceUID)}` +
    `/series/${encodeURIComponent(series.seriesInstanceUID)}/metadata`
  );
}

export function presentSeriesRail(args: {
  series: readonly CaseSeries[];
  /**
   * False until the main viewport has its first image. Covers stay unrequested.
   * Undefined leaves the series untouched (no gate, no pending state).
   */
  mainImageReady: boolean | undefined;
  known: Readonly<Record<string, RailStats>>;
  fetched: Readonly<Record<string, RailStats>>;
  /** Lookup finished without a usable instance list. */
  failed: ReadonlySet<string>;
}): RailEntry[] {
  if (args.mainImageReady === undefined) {
    return args.series.map((series) => ({ ...series }));
  }
  return args.series.map((series) => {
    const uid = series.seriesInstanceUID;
    const stats = args.fetched[uid] ?? args.known[uid];
    const bundled = isBundledSeries(series);
    const failed = args.failed.has(uid);
    const rawCount = series.instanceCount;
    const serverCount = rawCount != null && rawCount > 0 ? rawCount : 0;
    const count = stats?.instanceCount ?? serverCount;
    // Stay pending through the gap before the lookup's setState lands, so the
    // row never flashes "0 images" on the frame the viewport becomes ready.
    const countPending = !bundled && !stats && serverCount <= 0 && !failed;
    const thumbnailInstanceUID = args.mainImageReady
      ? stats?.thumbnailInstanceUID ?? series.thumbnailInstanceUID
      : undefined;
    // A settled lookup with no SOP (empty series) stops the spinner.
    const thumbPending =
      !bundled &&
      !thumbnailInstanceUID &&
      (args.mainImageReady ? !failed && !stats : true);
    return {
      ...series,
      instanceCount: countPending ? 0 : count,
      thumbnailInstanceUID,
      countPending,
      thumbPending,
    };
  });
}

const INSTANCE_PAGE = 2000;

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`series rail ${res.status}`);
  return res.json();
}

/**
 * Instance count and middle SOP for one series.
 * QIDO is the small call. If it comes back empty (Healthcare often omits the
 * count tag and an early instance search can miss), WADO-RS series metadata
 * is the same document the viewer already used to paint the stack.
 */
// One lookup per series per page open: the rail's effect can run twice for the
// same list (a re-render while the first lookup is in flight), and each
// lookup is a full QIDO instance list. Real fetches only — injected fetchers
// (tests) bypass the memo.
const RAIL_MEMO_MS = 60_000;
const railMemo = new Map<string, { at: number; promise: Promise<RailStats> }>();

export function fetchSeriesRailStats(
  series: CaseSeries,
  fetchImpl: typeof fetch = fetch
): Promise<RailStats> {
  if (fetchImpl !== fetch) return fetchSeriesRailStatsUncached(series, fetchImpl);
  const key = seriesInstanceSearchUrl(series);
  const hit = railMemo.get(key);
  if (hit && Date.now() - hit.at < RAIL_MEMO_MS) return hit.promise;
  const promise = fetchSeriesRailStatsUncached(series, fetchImpl);
  railMemo.set(key, { at: Date.now(), promise });
  promise.catch(() => railMemo.delete(key));
  return promise;
}

async function fetchSeriesRailStatsUncached(
  series: CaseSeries,
  fetchImpl: typeof fetch
): Promise<RailStats> {
  const init = {
    credentials: "same-origin" as const,
    headers: { Accept: "application/dicom+json" },
    priority: "low" as const,
  } as RequestInit & { priority: "low" };
  const rows: unknown[] = [];
  for (let offset = 0; offset < 50_000; offset += INSTANCE_PAGE) {
    const res = await fetchImpl(seriesInstanceSearchUrl(series, offset, INSTANCE_PAGE), init);
    const body = await readJson(res);
    if (!Array.isArray(body) || body.length === 0) break;
    rows.push(...body);
    if (body.length < INSTANCE_PAGE) break;
  }
  const fromQido = railStatsFromDicomJson(rows);
  if (fromQido.instanceCount > 0 && fromQido.thumbnailInstanceUID) return fromQido;

  const metadata = await fetchImpl(seriesMetadataUrl(series), init);
  return railStatsFromDicomJson(await readJson(metadata));
}
