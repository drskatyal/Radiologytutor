// Recent studies, as the desktop viewer keeps them: a short list of what was
// opened in this browser, newest first, each reopenable in one click where
// the browser can keep a handle to the folder (Chromium's File System Access).
//
// Pure: the entry shape, merging, labels. The app stores entries (with the
// handles beside them) in this browser's IndexedDB; nothing leaves it.
//
// No patient identifiers: an entry holds the study description, modality,
// study date and counts, never a name, ID, birth date or accession, and not
// even the Study Instance UID: the key is a one-way hash of the UIDs, used
// only to replace an entry when the same study is opened again. To offer
// "Compare with prior…" an entry may also hold a patient key: the study's
// one-way patient key (localStudy.patientKeyOf) hashed again with a random
// salt that never leaves this browser, so it matches only this browser's
// other entries and tells nothing about the patient on its own.

export interface RecentStudyStudy {
  studyInstanceUID: string;
  description?: string;
  studyDate?: string;
  imageCount: number;
  series: readonly { modality?: string }[];
  /** One-way patient key (localStudy.patientKeyOf), never the Patient ID. */
  patientKey?: string;
}

export interface RecentStudy {
  /** One-way hash of the opened studies' UIDs (dedupe only). */
  key: string;
  /** "Chest abdomen pelvis", or the first study's description. */
  description: string;
  /** "CT", "CT · PT"… */
  modalities: string;
  /** DICOM DA (YYYYMMDD) of the first study, when known. */
  studyDate?: string;
  studies: number;
  series: number;
  images: number;
  /** ms since epoch. */
  openedAt: number;
  /** Salted one-way patient key (see the module header), when one patient's studies were opened. */
  patientKey?: string;
}

/** How many the list keeps (searchable, as the desktop's study history is). */
export const RECENT_STUDIES_MAX = 50;

/** FNV-1a, 64-bit as two 32-bit halves: a stable, one-way dedupe key. */
function hashKey(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100019b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * The entry for what was just opened (one or more studies), or null when there
 * is nothing. With this browser's `salt`, it also holds the patient key when
 * every study is the same patient's.
 */
export function recentStudyEntry(studies: readonly RecentStudyStudy[], now: number, salt?: string): RecentStudy | null {
  if (studies.length === 0) return null;
  const uids = studies.map((s) => s.studyInstanceUID).sort();
  const first = studies[0]!;
  const modalities = [...new Set(studies.flatMap((s) => s.series.map((x) => (x.modality ?? "").trim().toUpperCase()).filter(Boolean)))];
  const description = studies.map((s) => s.description?.trim()).find(Boolean) ?? "";
  return {
    key: hashKey(uids.join("|")),
    description: description.slice(0, 120),
    modalities: modalities.slice(0, 4).join(" · "),
    studyDate: /^\d{8}$/.test(first.studyDate ?? "") ? first.studyDate : undefined,
    studies: studies.length,
    series: studies.reduce((n, s) => n + s.series.length, 0),
    images: studies.reduce((n, s) => n + s.imageCount, 0),
    openedAt: now,
    ...(salt && first.patientKey && studies.every((s) => s.patientKey === first.patientKey)
      ? { patientKey: hashKey(`${salt}|${first.patientKey}`) }
      : {}),
  };
}

/**
 * The desktop's "Compare with prior": this patient's earlier single-study
 * entries, newest first. Only entries of the same patient key and an earlier
 * study date (a same-day or undated study is no prior); never the open study
 * itself, nor an entry that already holds several studies.
 */
export function priorsAmong<T extends RecentStudy>(list: readonly T[], current: Pick<RecentStudy, "key" | "patientKey" | "studyDate">): T[] {
  const date = current.studyDate;
  if (!current.patientKey || !date) return [];
  return list
    .filter((e) => e.key !== current.key && e.studies === 1 && e.patientKey === current.patientKey && !!e.studyDate && e.studyDate < date)
    .sort((a, b) => (b.studyDate ?? "").localeCompare(a.studyDate ?? ""));
}

/** The list with `entry` at the top (replacing the same study), capped. */
export function withRecentStudy<T extends RecentStudy>(list: readonly T[], entry: T, max = RECENT_STUDIES_MAX): T[] {
  return [entry, ...list.filter((e) => e.key !== entry.key)].slice(0, max);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Mar 2024" from DICOM DA, or "" when it isn't one. */
export function studyDateLabel(da?: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(da ?? "");
  if (!m) return "";
  const month = Number(m[2]);
  if (month < 1 || month > 12) return "";
  return `${Number(m[3])} ${MONTHS[month - 1]} ${m[1]}`;
}

/** The row's title: the description, else the modality, else "Study". */
export function recentStudyTitle(e: RecentStudy): string {
  return e.description || (e.modalities ? `${e.modalities} study` : "Study");
}

/** The row's detail: "CT · 12 Mar 2024 · 3 series, 240 images". */
export function recentStudyDetail(e: RecentStudy): string {
  const counts = `${e.series} series, ${e.images} image${e.images === 1 ? "" : "s"}`;
  return [e.modalities, studyDateLabel(e.studyDate), e.studies > 1 ? `${e.studies} studies` : "", counts].filter(Boolean).join(" · ");
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", or the date. */
export function openedAgo(openedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - openedAt) / 1000));
  if (s < 60) return "just now";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  const date = new Date(openedAt);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const fold = (v: string) => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Everything an entry can be found by: description, modalities and the study date (DA, ISO and "12 Mar 2024"). */
function haystack(e: RecentStudy): string {
  const date = e.studyDate ?? "";
  const iso = /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : "";
  return fold([e.description, e.modalities, date, iso, studyDateLabel(date)].filter(Boolean).join(" \u0000 "));
}

/**
 * The entries matching `query`, as the desktop searches its study history:
 * every word must appear (any order, case and accents ignored). An empty
 * query keeps the whole list.
 */
export function searchRecentStudies<T extends RecentStudy>(list: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((e) => {
    const text = haystack(e);
    return words.every((w) => text.includes(w));
  });
}

// ── On / off (the desktop's "Local study database" setting) ──
// On by default, as on the desktop. Off: nothing opened is remembered from
// then on, and the app clears what was kept (list, handles and salt).

export const RECENT_STUDIES_ENABLED_STORAGE_KEY = "flowrad.viewer.recentStudies";

export interface RecentStudiesSettingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readRecentStudiesEnabled(store: RecentStudiesSettingStore | null): boolean {
  try {
    return store?.getItem(RECENT_STUDIES_ENABLED_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeRecentStudiesEnabled(on: boolean, store: RecentStudiesSettingStore | null): void {
  try {
    store?.setItem(RECENT_STUDIES_ENABLED_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* not remembered; still applies for this visit */
  }
}
