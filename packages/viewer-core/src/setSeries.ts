// set_series — the only way the tutor may change series.
//
// Gemini must copy a SeriesInstanceUID that already belongs to the case.
// That is a series on the loaded rail, a studyRef subset, a finding anchor,
// or (when a LiveTeachingPack lands) finding.drive / finding.compare.
// A UID that is not in that set is dropped. We never invent one.

export interface SetSeriesCall {
  type: "set_series";
  seriesInstanceUID: string;
  sliceIndex?: number;
  ww?: number;
  wc?: number;
}

/** One row of the series catalog we show the tutor. Descriptions are labels, not UIDs. */
export interface SeriesCatalogEntry {
  seriesInstanceUID: string;
  modality?: string;
  description?: string;
  seriesNumber?: number;
  instanceCount?: number;
}

/**
 * Structural finding shape. Today's `Finding` fills series / anchors / guide.
 * A LiveTeachingPack finding adds `drive.seriesInstanceUID` and
 * `compare.seriesInstanceUID` without a mapper change.
 */
export interface SeriesAnchorSource {
  seriesInstanceUID?: string | null;
  anchors?: Array<{ seriesInstanceUID?: string | null } | null> | null;
  teachingGuide?: {
    beats?: Array<{
      actions?: Array<{ type?: string; seriesInstanceUID?: string | null } | null> | null;
    } | null> | null;
  } | null;
  track?: {
    events?: Array<{ type?: string; seriesInstanceUID?: string | null } | null> | null;
  } | null;
  drive?: { seriesInstanceUID?: string | null } | null;
  compare?: { seriesInstanceUID?: string | null } | null;
}

const UID_MAX = 128;

export function cleanSeriesUid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const uid = value.trim();
  if (!uid || uid.length > UID_MAX) return null;
  if (/[\s,]/.test(uid)) return null;
  return uid;
}

function addUid(into: Set<string>, value: unknown) {
  const uid = cleanSeriesUid(value);
  if (uid) into.add(uid);
}

function absorbFinding(into: Set<string>, finding: SeriesAnchorSource | null | undefined) {
  if (!finding) return;
  addUid(into, finding.seriesInstanceUID);
  addUid(into, finding.drive?.seriesInstanceUID);
  addUid(into, finding.compare?.seriesInstanceUID);
  for (const anchor of finding.anchors ?? []) addUid(into, anchor?.seriesInstanceUID);
  for (const beat of finding.teachingGuide?.beats ?? []) {
    for (const action of beat?.actions ?? []) addUid(into, action?.seriesInstanceUID);
  }
  for (const event of finding.track?.events ?? []) {
    if (event?.type === "series") addUid(into, event.seriesInstanceUID);
  }
}

/**
 * Every series UID the tutor is allowed to name. Union of the loaded rail,
 * study-ref subsets, and authored anchors (including future drive/compare).
 */
export function authoredSeriesAllowlist(input: {
  series?: Array<{ seriesInstanceUID?: string | null } | null> | null;
  studyRefs?: Array<{ seriesInstanceUIDs?: string[] | null } | null> | null;
  findings?: Array<SeriesAnchorSource | null | undefined> | null;
  /**
   * LiveTeachingPack. `authoredSeriesInstanceUIDs` is the pack's own allowlist.
   * Finding drive/compare are scanned the same way as case findings.
   */
  pack?: {
    authoredSeriesInstanceUIDs?: readonly string[] | null;
    findings?: Array<SeriesAnchorSource | null | undefined> | null;
    drive?: { seriesInstanceUID?: string | null } | null;
    compare?: { seriesInstanceUID?: string | null } | null;
  } | null;
}): Set<string> {
  const allow = new Set<string>();
  for (const series of input.series ?? []) addUid(allow, series?.seriesInstanceUID);
  for (const ref of input.studyRefs ?? []) {
    for (const uid of ref?.seriesInstanceUIDs ?? []) addUid(allow, uid);
  }
  for (const finding of input.findings ?? []) absorbFinding(allow, finding);
  if (input.pack) {
    for (const uid of input.pack.authoredSeriesInstanceUIDs ?? []) addUid(allow, uid);
    addUid(allow, input.pack.drive?.seriesInstanceUID);
    addUid(allow, input.pack.compare?.seriesInstanceUID);
    for (const finding of input.pack.findings ?? []) absorbFinding(allow, finding);
  }
  return allow;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function finiteIndex(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n == null) return undefined;
  const index = Math.round(n);
  return index >= 0 ? index : undefined;
}

/** Map a model `set_series` object. Empty UID becomes a no-op. Allowlist is separate. */
export function parseSetSeriesArgs(args: Record<string, unknown> | null | undefined): SetSeriesCall | null {
  const seriesInstanceUID = cleanSeriesUid(args?.seriesInstanceUID);
  if (!seriesInstanceUID) return null;
  const sliceIndex = finiteIndex(args?.sliceIndex);
  const ww = finiteNumber(args?.ww ?? args?.windowWidth);
  const wc = finiteNumber(args?.wc ?? args?.windowCenter);
  return {
    type: "set_series",
    seriesInstanceUID,
    ...(sliceIndex != null ? { sliceIndex } : {}),
    ...(ww != null && wc != null ? { ww, wc } : {}),
  };
}

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function finiteInt(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n == null) return undefined;
  return Math.round(n);
}

/** Trust only a small catalog the student page already resolved. */
export function parseSeriesCatalog(raw: unknown): SeriesCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SeriesCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 64)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const seriesInstanceUID = cleanSeriesUid(rec.seriesInstanceUID);
    if (!seriesInstanceUID || seen.has(seriesInstanceUID)) continue;
    seen.add(seriesInstanceUID);
    const seriesNumber = finiteInt(rec.seriesNumber);
    const instanceCount = finiteInt(rec.instanceCount);
    out.push({
      seriesInstanceUID,
      modality: shortText(rec.modality, 16),
      description: shortText(rec.description, 120),
      ...(seriesNumber != null ? { seriesNumber } : {}),
      ...(instanceCount != null && instanceCount >= 0 ? { instanceCount } : {}),
    });
  }
  return out;
}

/**
 * Rows to put in the tutor prompt. Prefer the loaded rail (it has descriptions).
 * When the client sent none, fall back to authored UIDs so drive/compare still
 * have a name the model can copy.
 */
export function promptSeriesCatalog(
  client: SeriesCatalogEntry[],
  allow: ReadonlySet<string>
): SeriesCatalogEntry[] {
  const listed = client.filter((entry) => allow.has(entry.seriesInstanceUID));
  if (listed.length > 0) return listed;
  return [...allow].map((seriesInstanceUID) => ({ seriesInstanceUID }));
}

type SeriesAction = {
  type: string;
  seriesInstanceUID?: string;
};

/**
 * Drop a series change whose UID is not on the allowlist.
 * `scroll_to` that names a foreign series is dropped whole — scrolling the
 * current stack to another series' index would land on the wrong anatomy.
 */
export function sanitizeSeriesActions<T extends SeriesAction>(
  actions: readonly T[],
  allow: ReadonlySet<string>
): T[] {
  const out: T[] = [];
  for (const action of actions) {
    if (action.type !== "set_series" && action.type !== "scroll_to") {
      out.push(action);
      continue;
    }
    if (!action.seriesInstanceUID) {
      if (action.type === "set_series") continue;
      out.push(action);
      continue;
    }
    if (!allow.has(action.seriesInstanceUID)) continue;
    out.push(action);
  }
  return out;
}
