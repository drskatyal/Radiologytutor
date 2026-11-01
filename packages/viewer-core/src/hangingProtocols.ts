// Hanging protocols: what a radiologist expects to see the moment a study
// opens, chosen from the study itself (modality, orientation, description,
// slice thickness, and whether a prior of the same patient is open too).
//
// Pure: the apps map their series into `HpSeries` and apply the plan (grid,
// which series in which cell, synced scrolling). Rules, in order:
//
//   1. Current vs prior: two or more studies of one patient with a shared
//      modality → 1×2, current (newest) left, prior right, matched series,
//      synced scrolling (by position; see `priorOffsetMm`).
//   2. CT: axial soft tissue; + lung kernel → 1×2; + coronal & sagittal
//      reformats → 2×2 (axial, coronal, sagittal, lung or 2nd axial).
//   3. MR: up to four sequences by clinical priority (T1, T2, FLAIR, DWI, ADC,
//      post-contrast…) → 1×1 / 1×2 / 1×3 / 2×2.
//   4. CR / DX / MG / XA single images: the views side by side (up to 4).
//   5. Anything else: null — the app keeps its default.

export type Orientation = "axial" | "coronal" | "sagittal" | "oblique";

export interface HpSeries {
  uid: string;
  modality: string;
  description: string;
  imageCount: number;
  number?: number;
  orientation?: Orientation | null;
  /** mm */
  sliceThickness?: number;
  /** Most superior / inferior slice position along the patient axis (mm), for prior registration. */
  zRange?: [number, number];
}

export interface HpStudy {
  uid: string;
  /** DICOM DA (YYYYMMDD). */
  date?: string;
  patientId?: string;
  series: HpSeries[];
}

export interface HangingPlan {
  protocol: "compare" | "ct" | "mr" | "projection";
  /** Short label for the status bar, e.g. "CT: axial · lung · coronal · sagittal". */
  label: string;
  rows: number;
  cols: number;
  /** Series UID per cell, row-major. */
  cells: (string | null)[];
  syncScroll: boolean;
  /** Current vs prior: the pair, and the z offset that registers prior to current (mm). */
  compare?: { currentStudy: string; priorStudy: string; currentSeries: string; priorSeries: string; priorOffsetMm: number };
}

/** Orientation from Image Orientation (Patient): the normal's dominant axis. */
export function orientationOf(iop?: readonly number[] | null): Orientation | null {
  if (!iop || iop.length < 6) return null;
  const [r1, r2, r3, c1, c2, c3] = iop;
  const n = [r2 * c3 - r3 * c2, r3 * c1 - r1 * c3, r1 * c2 - r2 * c1].map(Math.abs);
  const max = Math.max(...n);
  if (max < 0.8) return "oblique";
  return n[2] === max ? "axial" : n[1] === max ? "coronal" : "sagittal";
}

const has = (s: HpSeries, re: RegExp) => re.test(s.description);
const isLocalizer = (s: HpSeries) => s.imageCount < 4 || has(s, /scout|locali[sz]er|topogram|surview|survey|\bloc\b|tripilot|3.?plane/i);
const isDerived = (s: HpSeries) => has(s, /dose|report|screen ?save|patient protocol|summary|key ?image/i);

function stacks(study: HpStudy, modality: string): HpSeries[] {
  return study.series.filter((s) => s.modality === modality && !isLocalizer(s) && !isDerived(s));
}

/** Largest first, then thinner slices, then lower series number. */
function byPrimary(a: HpSeries, b: HpSeries): number {
  return (
    b.imageCount - a.imageCount ||
    (a.sliceThickness ?? 99) - (b.sliceThickness ?? 99) ||
    (a.number ?? 1e9) - (b.number ?? 1e9)
  );
}

function grid(n: number): { rows: number; cols: number } {
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n === 2) return { rows: 1, cols: 2 };
  if (n === 3) return { rows: 1, cols: 3 };
  return { rows: 2, cols: 2 };
}

function plan(protocol: HangingPlan["protocol"], label: string, uids: string[], syncScroll: boolean): HangingPlan {
  const cells = uids.slice(0, 4);
  return { protocol, label, ...grid(cells.length), cells, syncScroll };
}

// ───────────────────────────── CT ─────────────────────────────

const LUNG = /lung|pulm|chest ?w(in|indow)|bone ?plus|\bb[67]0|\bi70|\bfc5[0-9]|\byb\b|sharp|hr\b/i;

export function ctPlan(study: HpStudy): HangingPlan | null {
  const all = stacks(study, "CT");
  if (!all.length) return null;
  const axial = all.filter((s) => (s.orientation ?? "axial") === "axial").sort(byPrimary);
  const soft = axial.find((s) => !has(s, LUNG)) ?? axial[0];
  const lung = axial.find((s) => s !== soft && has(s, LUNG));
  const coronal = all.filter((s) => s.orientation === "coronal").sort(byPrimary)[0];
  const sagittal = all.filter((s) => s.orientation === "sagittal").sort(byPrimary)[0];
  if (!soft) {
    const first = all.sort(byPrimary)[0];
    return plan("ct", "CT", [first.uid], false);
  }
  if (coronal && sagittal) {
    const fourth = lung ?? axial.find((s) => s !== soft);
    const uids = [soft.uid, coronal.uid, sagittal.uid, ...(fourth ? [fourth.uid] : [])];
    return plan("ct", `CT: axial · coronal · sagittal${lung ? " · lung" : ""}`, uids, false);
  }
  if (lung) return plan("ct", "CT: soft tissue · lung", [soft.uid, lung.uid], true);
  return plan("ct", "CT: axial", [soft.uid], false);
}

// ───────────────────────────── MR ─────────────────────────────

/** Clinical reading order; first match wins per series. */
const MR_PRIORITY: [string, RegExp][] = [
  ["T1", /\bt1(?!.*(\+|post|gad|gd|\bc\b|contrast|mprage.*post))/i],
  ["T2", /\bt2(?!\*|.*(flair|star|gre|swi))/i],
  ["FLAIR", /flair|\bdark ?fluid/i],
  ["DWI", /\bdwi\b|diff|trace|\bb ?=? ?(800|1000|1400)/i],
  ["ADC", /\badc\b|apparent/i],
  ["T1+C", /(\bt1|mprage|vibe|lava|thrive).*(\+|post|gad|gd|\bc\b|contrast)|(\+|post).*\bt1/i],
  ["SWI", /swi|t2\*|gre|hemo/i],
  ["STIR", /stir|tirm/i],
  ["PD", /\bpd\b|proton/i],
];

export function mrPlan(study: HpStudy): HangingPlan | null {
  const all = stacks(study, "MR").filter((s) => !has(s, /\bmip\b|\bsub\b|perf|spectro|svs/i));
  if (!all.length) return null;
  const picked: { tag: string; s: HpSeries }[] = [];
  for (const [tag, re] of MR_PRIORITY) {
    const hit = all
      .filter((s) => re.test(s.description) && !picked.some((p) => p.s === s))
      // Prefer axial for the same sequence, then the larger stack.
      .sort((a, b) => Number(b.orientation === "axial") - Number(a.orientation === "axial") || byPrimary(a, b))[0];
    if (hit) picked.push({ tag, s: hit });
    if (picked.length === 4) break;
  }
  if (!picked.length) {
    const first = all.sort(byPrimary)[0];
    return plan("mr", "MR", [first.uid], false);
  }
  // Same-orientation sequences scroll together.
  const sameOrientation = new Set(picked.map((p) => p.s.orientation ?? "axial")).size === 1;
  return plan("mr", `MR: ${picked.map((p) => p.tag).join(" · ")}`, picked.map((p) => p.s.uid), sameOrientation && picked.length > 1);
}

// ─────────────────────── CR / DX / MG / XA ───────────────────────

const PROJECTION = new Set(["CR", "DX", "MG", "XA", "RF", "IO", "PX"]);
const VIEW_ORDER = [/\bpa\b|frontal|\bap\b/i, /\blat|lateral/i, /\bcc\b/i, /\bmlo\b/i, /obl/i];

export function projectionPlan(study: HpStudy): HangingPlan | null {
  const views = study.series.filter((s) => PROJECTION.has(s.modality) && !isDerived(s));
  if (!views.length) return null;
  const rank = (s: HpSeries) => {
    const i = VIEW_ORDER.findIndex((re) => re.test(s.description));
    return i < 0 ? VIEW_ORDER.length : i;
  };
  const ordered = [...views].sort((a, b) => rank(a) - rank(b) || (a.number ?? 1e9) - (b.number ?? 1e9));
  return plan("projection", `${views[0].modality}: ${Math.min(4, ordered.length)} view${ordered.length > 1 ? "s" : ""}`, ordered.map((s) => s.uid), false);
}

// ─────────────────────── current vs prior ───────────────────────

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9+]+/).filter((w) => w.length > 1));

/** How alike two series are, for pairing a prior with the current series (0–1). */
export function seriesSimilarity(a: HpSeries, b: HpSeries): number {
  if (a.modality !== b.modality) return 0;
  let score = (a.orientation ?? "axial") === (b.orientation ?? "axial") ? 0.4 : 0;
  const wa = words(a.description);
  const wb = words(b.description);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  score += 0.4 * (shared / Math.max(1, Math.max(wa.size, wb.size)));
  if (a.sliceThickness && b.sliceThickness) score += 0.2 * Math.min(a.sliceThickness, b.sliceThickness) / Math.max(a.sliceThickness, b.sliceThickness);
  return score;
}

/**
 * Automatic registration for synced prior/current scrolling: the offset (mm)
 * that maps a current slice position to the prior. Aligns the superior ends
 * of the two stacks (the head end is the most reproducible landmark across
 * a follow-up's different coverage); 0 when ranges are unknown.
 */
export function priorOffsetMm(current: HpSeries, prior: HpSeries): number {
  if (!current.zRange || !prior.zRange) return 0;
  return Math.max(...prior.zRange) - Math.max(...current.zRange);
}

export function comparePlan(studies: readonly HpStudy[]): HangingPlan | null {
  if (studies.length < 2) return null;
  const dated = [...studies].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const current = dated[0];
  const prior = dated.find(
    (s) => s !== current && (!current.patientId || !s.patientId || s.patientId === current.patientId) && s.date !== current.date
  );
  if (!prior) return null;
  // The current study's primary series, per its own protocol.
  const primaryUid = (ctPlan(current) ?? mrPlan(current) ?? projectionPlan(current))?.cells[0];
  const currentSeries = current.series.find((s) => s.uid === primaryUid);
  if (!currentSeries) return null;
  const match = prior.series
    .map((s) => ({ s, score: seriesSimilarity(currentSeries, s) }))
    .filter((m) => m.score >= 0.4 && !isLocalizer(m.s))
    .sort((a, b) => b.score - a.score || byPrimary(a.s, b.s))[0]?.s;
  if (!match) return null;
  return {
    protocol: "compare",
    label: `Current ${fmtDate(current.date)} vs prior ${fmtDate(prior.date)}`,
    rows: 1,
    cols: 2,
    cells: [currentSeries.uid, match.uid],
    syncScroll: true,
    compare: {
      currentStudy: current.uid,
      priorStudy: prior.uid,
      currentSeries: currentSeries.uid,
      priorSeries: match.uid,
      priorOffsetMm: priorOffsetMm(currentSeries, match),
    },
  };
}

function fmtDate(da?: string): string {
  return da && /^\d{8}$/.test(da) ? `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6)}` : "undated";
}

/** The plan for what just opened, or null to keep the app's default. */
export function chooseHangingProtocol(studies: readonly HpStudy[]): HangingPlan | null {
  const compare = comparePlan(studies);
  if (compare) return compare;
  const study = studies[0];
  if (!study) return null;
  return ctPlan(study) ?? mrPlan(study) ?? projectionPlan(study);
}
